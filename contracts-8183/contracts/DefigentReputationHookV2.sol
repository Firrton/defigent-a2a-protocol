// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC8183Hook.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice Read-only view of an ERC-8183 core job. Mirrors the deployed core's `Job` layout
///         (the same layout DefigentReputationHook v1 decodes on Monad mainnet).
interface IERC8183JobReader {
    struct Job {
        address client;
        uint8 status;
        address provider;
        uint48 expiredAt;
        address evaluator;
        uint48 submittedAt;
        uint256 budget;
        address hook;
        address paymentToken;
        uint256 providerAgentId;
        string description;
        uint256 settledAmount;
        address payoutReceiver;
    }

    function getJob(uint256 jobId) external view returns (Job memory);
}

/// @notice ERC-8004 Identity Registry (Monad singleton 0x8004A169…, version 2.0.0)
interface IERC8004IdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);

    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice ERC-8004 Reputation Registry (Monad singleton 0x8004BAa1…, version 2.0.0)
interface IERC8004ReputationRegistry {
    function getIdentityRegistry() external view returns (address);

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

/**
 * @title DefigentReputationHookV2
 * @notice ERC-8183 hook that attests completed jobs into the ERC-8004 Reputation
 *         Registry of Monad. Unlike v1, feedback is only written when:
 *         - the job's provider is the owner or the verified agent wallet of
 *           `providerAgentId`, so a client can no longer attest an arbitrary agent;
 *         - neither the client nor the evaluator is that agent's owner or agent
 *           wallet, and the payout does not go back to the client or the evaluator;
 *         - the job escrowed a nonzero budget, so free jobs earn no reputation.
 *         The feedback value is the job budget in payment-token units with the
 *         token's decimals, and `feedbackHash` is the deliverable hash the provider
 *         submitted. A registry or token that fails on its own (reverts, returns
 *         garbage, or exhausts its gas cap) never blocks settlement: the hook emits
 *         an event and the job completes. A transaction that does not carry enough
 *         gas for those calls reverts instead, so a low gas limit can never settle a
 *         job while silently dropping its attestation. No negative feedback is ever
 *         written (griefing-safe).
 */
contract DefigentReputationHookV2 is IERC8183Hook {
    /// @notice Whether a job's completion produces feedback, and if not, why.
    enum Eligibility {
        Eligible,
        NoAgentId, // the provider has no ERC-8004 identity on this job
        ZeroBudget, // nothing was escrowed
        BudgetTooLarge, // budget exceeds the registry's value bound
        ProviderNotBound, // provider is neither the agent's owner nor its agent wallet
        SelfDealing, // client or evaluator controls the agent, or the payout goes back to them
        InvalidDecimals, // payment token decimals are unreadable or above 18
        NotThisHook // eligibility() only: the job is not attached to this hook
    }

    address public immutable escrow;
    IERC8004ReputationRegistry public immutable reputation;
    IERC8004IdentityRegistry public immutable identity;
    /// @notice Endpoint written into every feedback entry. Set once at deployment.
    string public endpoint;

    string public constant TAG1 = "erc-8183-job";
    string public constant TAG2 = "escrow-settled";

    /// @notice The registry rejects |value| > 1e38 (ReputationRegistryUpgradeable.MAX_ABS_VALUE).
    uint256 public constant MAX_FEEDBACK_VALUE = 1e38;
    /// @notice The registry rejects valueDecimals > 18.
    uint256 public constant MAX_DECIMALS = 18;

    /// @notice Gas cap for giveFeedback. Bounds what a broken registry upgrade can burn. A first
    ///         feedback costs about 235k gas on Monad (registry 2.0.0, measured on a fork).
    uint256 public constant FEEDBACK_GAS = 500_000;
    /// @notice Gas cap for each identity or token read (about 27k cold on Monad).
    uint256 public constant VIEW_GAS = 100_000;
    /// @dev Covers cold account access and argument encoding between reading gasleft() and the call,
    ///      so that gasleft() >= cap * 64 / 63 + CALL_GAS_MARGIN guarantees the callee its full cap.
    uint256 private constant CALL_GAS_MARGIN = 50_000;

    // The core's submit.selector and complete.selector
    bytes4 private constant SUBMIT_SELECTOR = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 private constant COMPLETE_SELECTOR = bytes4(keccak256("complete(uint256,bytes32,bytes)"));

    /// @notice Deliverable hash the provider submitted, held until the job completes.
    mapping(uint256 jobId => bytes32 deliverable) public deliverableOf;

    event ReputationAttested(
        uint256 indexed jobId,
        uint256 indexed agentId,
        address indexed client,
        address provider,
        address paymentToken,
        int128 value,
        uint8 valueDecimals,
        bytes32 deliverable
    );
    event AttestationSkipped(uint256 indexed jobId, uint256 indexed agentId, Eligibility reason);
    event AttestationFailed(uint256 indexed jobId, uint256 indexed agentId);

    error NotEscrow();
    error NotAContract(address account);
    error InsufficientGas();

    /// @param escrow_     ERC-8183 core (proxy) allowed to call the hook
    /// @param reputation_ ERC-8004 Reputation Registry; the Identity Registry is read from it
    /// @param endpoint_   Endpoint recorded in every feedback entry
    constructor(address escrow_, address reputation_, string memory endpoint_) {
        if (escrow_.code.length == 0) revert NotAContract(escrow_);
        if (reputation_.code.length == 0) revert NotAContract(reputation_);
        address identity_ = IERC8004ReputationRegistry(reputation_).getIdentityRegistry();
        if (identity_.code.length == 0) revert NotAContract(identity_);

        escrow = escrow_;
        reputation = IERC8004ReputationRegistry(reputation_);
        identity = IERC8004IdentityRegistry(identity_);
        endpoint = endpoint_;
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external onlyEscrow {
        // no gating: anyone may work; reputation is earned, not required
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyEscrow {
        if (selector == SUBMIT_SELECTOR) {
            // the core encodes submit data as abi.encode(provider, deliverable, optParams);
            // read the second word only, without copying the provider's optParams
            deliverableOf[jobId] = bytes32(data[32:64]);
        } else if (selector == COMPLETE_SELECTOR) {
            _attest(jobId);
        }
    }

    /// @notice Preflight: whether `jobId` passes the attestation checks today, and with which decimals.
    ///         Meaningful as soon as the provider, agentId and budget are set, before funding. The
    ///         checks run again at completion, and the registry call itself can still fail. Like
    ///         completion, it reverts with InsufficientGas when given too little gas for its reads.
    function eligibility(uint256 jobId) external view returns (Eligibility status, uint8 valueDecimals) {
        IERC8183JobReader.Job memory job = IERC8183JobReader(escrow).getJob(jobId);
        if (job.hook != address(this)) return (Eligibility.NotThisHook, 0);
        return _eligibility(job);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC8183Hook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _attest(uint256 jobId) private {
        bytes32 deliverable = deliverableOf[jobId];
        delete deliverableOf[jobId];

        IERC8183JobReader.Job memory job = IERC8183JobReader(escrow).getJob(jobId);
        (Eligibility status, uint8 valueDecimals) = _eligibility(job);
        if (status != Eligibility.Eligible) {
            emit AttestationSkipped(jobId, job.providerAgentId, status);
            return;
        }

        // casting to 'int128' is safe because _eligibility caps the budget at MAX_FEEDBACK_VALUE (< type(int128).max)
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 value = int128(uint128(job.budget));
        string memory endpoint_ = endpoint; // load before measuring the gas available to the call
        uint256 gasBefore = gasleft();
        try reputation.giveFeedback{gas: FEEDBACK_GAS}(
            job.providerAgentId, value, valueDecimals, TAG1, TAG2, endpoint_, "", deliverable
        ) {
            emit ReputationAttested(
                jobId,
                job.providerAgentId,
                job.client,
                job.provider,
                job.paymentToken,
                value,
                valueDecimals,
                deliverable
            );
        } catch {
            _requireFullGasCap(gasBefore, FEEDBACK_GAS);
            // the registry failed on its own, e.g. the agent owner approved this hook as an
            // operator ("Self-feedback not allowed")
            emit AttestationFailed(jobId, job.providerAgentId);
        }
    }

    function _eligibility(IERC8183JobReader.Job memory job)
        private
        view
        returns (Eligibility status, uint8 valueDecimals)
    {
        uint256 agentId = job.providerAgentId;
        if (agentId == 0) return (Eligibility.NoAgentId, 0);
        if (job.budget == 0) return (Eligibility.ZeroBudget, 0);
        if (job.budget > MAX_FEEDBACK_VALUE) return (Eligibility.BudgetTooLarge, 0);
        // a payout that returns to the payer moves no value to the provider side
        address recipient = job.payoutReceiver == address(0) ? job.provider : job.payoutReceiver;
        if (recipient == job.client || recipient == job.evaluator) return (Eligibility.SelfDealing, 0);

        address owner =
            _staticcallAddress(address(identity), abi.encodeCall(IERC8004IdentityRegistry.ownerOf, (agentId)));
        address wallet =
            _staticcallAddress(address(identity), abi.encodeCall(IERC8004IdentityRegistry.getAgentWallet, (agentId)));
        if (!_controls(owner, wallet, job.provider)) return (Eligibility.ProviderNotBound, 0);
        if (_controls(owner, wallet, job.client) || _controls(owner, wallet, job.evaluator)) {
            return (Eligibility.SelfDealing, 0);
        }

        (bool ok, uint256 decimals) = _staticcallWord(job.paymentToken, abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!ok || decimals > MAX_DECIMALS) return (Eligibility.InvalidDecimals, 0);
        // casting to 'uint8' is safe because decimals <= MAX_DECIMALS (18)
        // forge-lint: disable-next-line(unsafe-typecast)
        return (Eligibility.Eligible, uint8(decimals));
    }

    /// @dev True when `account` is the agent's owner or its agent wallet. A zero
    ///      owner (nonexistent agent) or unset wallet never matches.
    function _controls(address owner, address wallet, address account) private pure returns (bool) {
        return account != address(0) && (account == owner || account == wallet);
    }

    /// @dev Address-returning variant of _staticcallWord; any failure or a word that is
    ///      not a clean address yields address(0).
    function _staticcallAddress(address target, bytes memory callData) private view returns (address account) {
        (bool ok, uint256 word) = _staticcallWord(target, callData);
        // casting to 'uint160' is safe because the upper 96 bits are checked to be zero
        // forge-lint: disable-next-line(unsafe-typecast)
        if (ok && word >> 160 == 0) account = address(uint160(word));
    }

    /// @dev Static-calls `target` with at most VIEW_GAS and returns the first word of its return data.
    ///      Whatever the target does, the result is data, not a revert: a revert, a target without
    ///      code, or return data shorter than one word all yield ok = false (with try/catch, a failed
    ///      ABI decode would escape the catch). Only one word of return data is ever copied. The one
    ///      revert is _requireFullGasCap's, when the call failed without being offered its full cap.
    function _staticcallWord(address target, bytes memory callData) private view returns (bool ok, uint256 word) {
        uint256 gasCap = VIEW_GAS;
        uint256 gasBefore = gasleft();
        bool success;
        assembly ("memory-safe") {
            success := staticcall(gasCap, target, add(callData, 0x20), mload(callData), 0x00, 0x20)
            ok := and(success, gt(returndatasize(), 0x1f))
            word := mul(mload(0x00), ok)
        }
        if (!success) _requireFullGasCap(gasBefore, gasCap);
    }

    /// @dev A failed call counts as the callee's own failure only if the callee could be handed its
    ///      whole gas cap. With less, the caller may have starved it on purpose (EIP-150 forwards at
    ///      most 63/64 of the remaining gas), so revert and make the transaction carry more gas
    ///      instead of recording a skip or a failure.
    function _requireFullGasCap(uint256 gasBefore, uint256 gasCap) private pure {
        if (gasBefore < gasCap * 64 / 63 + CALL_GAS_MARGIN) revert InsufficientGas();
    }
}
