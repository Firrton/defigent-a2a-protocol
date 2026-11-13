// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC8183Hook.sol";

/**
 * @title DefigentReputationHook
 * @notice ERC-8183 hook that attests job outcomes into the ERC-8004 Reputation
 *         Registry of Monad. When a job completes, the provider's agentId
 *         receives positive, escrow-attested feedback (the feedback is only
 *         written for jobs that were actually funded and settled on-chain).
 *         No negative feedback is ever written (griefing-safe MVP).
 */
interface IERC8183CoreView {
    struct JobView {
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

    function getJob(uint256 jobId) external view returns (JobView memory);
}

interface IERC8004Reputation {
    /// @notice ERC-8004 Reputation Registry (Monad mainnet deployment, selector 0x3c036a7e)
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 decimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata fileUrl,
        bytes32 fileHash
    ) external;
}

contract DefigentReputationHook is IERC8183Hook {
    address public immutable escrow;
    IERC8004Reputation public immutable reputation;
    string public constant INBOX_ENDPOINT = "https://opacus-liana-lanceted.ngrok-free.dev/inbox";

    uint128 public constant REWARD_ON_COMPLETE = 10; // escrow-attested positive feedback
    uint8 public constant DECIMALS = 0;

    // bytes4(keccak256("complete(uint256,bytes32,bytes)")) — the core's complete.selector
    bytes4 private constant COMPLETE_SELECTOR = bytes4(keccak256("complete(uint256,bytes32,bytes)"));

    event ReputationAttested(uint256 indexed jobId, uint256 indexed agentId, int128 value);

    error NotEscrow();
    error UnknownSelector();

    constructor(address escrow_, address reputation_) {
        escrow = escrow_;
        reputation = IERC8004Reputation(reputation_);
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external onlyEscrow {
        // no gating in this MVP: anyone may work; reputation is earned, not required
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata) external onlyEscrow {
        // React ONLY to successful completions
        if (selector != COMPLETE_SELECTOR) return;
        IERC8183CoreView.JobView memory job = IERC8183CoreView(escrow).getJob(jobId);
        if (job.providerAgentId == 0) return; // provider without ERC-8004 identity: nothing to attest
        reputation.giveFeedback(
            job.providerAgentId,
            int128(uint128(REWARD_ON_COMPLETE)),
            DECIMALS,
            "erc-8183-job",
            "escrow-settled",
            INBOX_ENDPOINT,
            "",
            bytes32(0)
        );
        emit ReputationAttested(jobId, job.providerAgentId, int128(uint128(REWARD_ON_COMPLETE)));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC8183Hook).interfaceId || interfaceId == 0x01ffc9a7;
    }
}
