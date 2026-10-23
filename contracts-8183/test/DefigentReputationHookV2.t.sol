// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ERC8183} from "../contracts/ERC8183.sol";
import {IERC8183Hook} from "../contracts/IERC8183Hook.sol";
import {DefigentReputationHookV2} from "../contracts/DefigentReputationHookV2.sol";
import {MockUSDC} from "../contracts/mocks/MockUSDC.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Identity registry double. ownerOf reverts for unknown agents, like the real ERC-721.
contract MockIdentityRegistry {
    error ERC721NonexistentToken(uint256 tokenId);

    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _wallets;
    bool public burnGas; // models a broken or hostile registry upgrade
    uint256 public minEntryGas; // when set, reads fail unless handed at least this much gas

    function setAgent(uint256 agentId, address owner, address wallet) external {
        _owners[agentId] = owner;
        _wallets[agentId] = wallet;
    }

    function setBurnGas(bool burnGas_) external {
        burnGas = burnGas_;
    }

    function setMinEntryGas(uint256 minEntryGas_) external {
        minEntryGas = minEntryGas_;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        _entryChecks(gasleft());
        owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        _entryChecks(gasleft());
        return _wallets[agentId];
    }

    /// @dev `entryGas` is read before any storage access, so a cold slot cannot skew it.
    function _entryChecks(uint256 entryGas) private view {
        require(entryGas >= minEntryGas, "starved");
        if (burnGas) {
            while (true) {}
        }
    }
}

/// @notice Reputation registry double. Records feedback and enforces the deployed
///         registry's write bounds (valueDecimals <= 18, |value| <= 1e38).
contract MockReputationRegistry {
    struct Feedback {
        address client;
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    address public immutable identityRegistry;
    bool public shouldRevert;
    uint256 public minEntryGas; // when set, giveFeedback fails unless handed at least this much gas
    uint256 public extraSlots; // fresh storage slots written per feedback, to make the call expensive
    uint256 private _scratchCursor;
    mapping(uint256 => uint256) private _scratch;
    Feedback[] private _feedback;

    constructor(address identityRegistry_) {
        identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return identityRegistry;
    }

    function setShouldRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function setExtraSlots(uint256 extraSlots_) external {
        extraSlots = extraSlots_;
    }

    function setMinEntryGas(uint256 minEntryGas_) external {
        minEntryGas = minEntryGas_;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        _checkEntryGas(gasleft());
        require(!shouldRevert, "Self-feedback not allowed");
        require(valueDecimals <= 18, "too many decimals");
        require(value >= -1e38 && value <= 1e38, "value too large");
        uint256 cursor = _scratchCursor;
        for (uint256 i = 0; i < extraSlots; i++) {
            _scratch[cursor + i] = i + 1;
        }
        _scratchCursor = cursor + extraSlots;
        _feedback.push(
            Feedback(msg.sender, agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)
        );
    }

    /// @dev `entryGas` is read before any storage access, so a cold slot cannot skew it.
    function _checkEntryGas(uint256 entryGas) private view {
        require(entryGas >= minEntryGas, "starved");
    }

    function feedbackCount() external view returns (uint256) {
        return _feedback.length;
    }

    function feedbackAt(uint256 index) external view returns (Feedback memory) {
        return _feedback[index];
    }
}

/// @notice ERC-20 whose decimals() can revert, exceed the registry bound, or return no data.
contract MockOddDecimalsToken is ERC20 {
    enum Mode {
        Normal,
        Reverts,
        TooLarge,
        Empty
    }

    Mode public mode;

    constructor() ERC20("Odd Decimals", "ODD") {}

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        Mode m = mode;
        if (m == Mode.Reverts) revert("no decimals");
        if (m == Mode.TooLarge) return 19;
        if (m == Mode.Empty) {
            assembly {
                return(0, 0)
            }
        }
        return 6;
    }
}

/// @notice Shared fixture: the real ERC-8183 core (UUPS proxy), ERC-8004 registry doubles and
///         DefigentReputationHookV2 wired together.
abstract contract HookV2Fixture is Test {
    uint256 constant AGENT_ID = 10407;
    uint256 constant BUDGET = 250_000; // 0.25 USDC (6 decimals)
    uint256 constant REGISTRY_VALUE_BOUND = 1e38;
    bytes32 constant DELIVERABLE = keccak256("final deliverable");
    bytes32 constant MILESTONE = keccak256("milestone deliverable");
    string constant ENDPOINT = "https://defigent.example/inbox";

    ERC8183 core;
    MockUSDC usdc;
    MockIdentityRegistry identity;
    MockReputationRegistry reputation;
    DefigentReputationHookV2 hook;

    address deployer = makeAddr("deployer");
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    address stranger = makeAddr("stranger");

    // Events (must match DefigentReputationHookV2.sol exactly for vm.expectEmit)
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
    event AttestationSkipped(
        uint256 indexed jobId, uint256 indexed agentId, DefigentReputationHookV2.Eligibility reason
    );
    event AttestationFailed(uint256 indexed jobId, uint256 indexed agentId);

    function setUp() public virtual {
        vm.startPrank(deployer);

        usdc = new MockUSDC();

        ERC8183 impl = new ERC8183();
        bytes memory initData = abi.encodeCall(ERC8183.initialize, (deployer, deployer));
        core = ERC8183(address(new ERC1967Proxy(address(impl), initData)));
        core.setPaymentTokenAllowed(address(usdc), true);

        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry(address(identity));
        hook = new DefigentReputationHookV2(address(core), address(reputation), ENDPOINT);
        core.setHookWhitelist(address(hook), true);

        vm.stopPrank();

        identity.setAgent(AGENT_ID, provider, provider);
    }

    // ──────────────────── Helpers ────────────────────

    function _createJob(uint256 agentId) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = core.createJob(
            provider, evaluator, uint48(block.timestamp + 1 days), "hook v2 job", address(hook), agentId
        );
    }

    function _fund(uint256 jobId, address token, uint256 budget) internal {
        vm.prank(provider);
        core.setBudget(jobId, token, budget, "");
        IMintable(token).mint(client, budget);
        vm.startPrank(client);
        IERC20(token).approve(address(core), budget);
        core.fund(jobId, token, budget, "");
        vm.stopPrank();
    }

    function _submit(uint256 jobId, bytes32 deliverable) internal {
        vm.prank(provider);
        core.submit(jobId, deliverable, "");
    }

    function _complete(uint256 jobId) internal {
        vm.prank(evaluator);
        core.complete(jobId, bytes32("approved"), "");
    }

    function _submittedJob(uint256 agentId, address token, uint256 budget) internal returns (uint256 jobId) {
        jobId = _createJob(agentId);
        _fund(jobId, token, budget);
        _submit(jobId, DELIVERABLE);
    }

    function _expectSkipped(uint256 jobId, uint256 agentId, DefigentReputationHookV2.Eligibility reason) internal {
        vm.expectEmit(true, true, false, true, address(hook));
        emit AttestationSkipped(jobId, agentId, reason);
    }

    function _assertSettled(uint256 jobId, address token, uint256 budget) internal view {
        assertEq(uint8(core.getJob(jobId).status), uint8(ERC8183.JobStatus.Completed));
        assertEq(IERC20(token).balanceOf(provider), budget);
        assertEq(hook.deliverableOf(jobId), bytes32(0));
    }

    function _oddToken(MockOddDecimalsToken.Mode mode) internal returns (MockOddDecimalsToken token) {
        token = new MockOddDecimalsToken();
        token.setMode(mode);
        vm.prank(deployer);
        core.setPaymentTokenAllowed(address(token), true);
    }

    function _tryComplete(uint256 jobId, uint256 gasLimit) internal returns (bool ok, bytes memory ret) {
        vm.prank(evaluator);
        (ok, ret) =
            address(core).call{gas: gasLimit}(abi.encodeCall(ERC8183.complete, (jobId, bytes32("approved"), "")));
    }

    /// @dev Completes `jobId` under every gas limit from a third of an unconstrained run's usage to
    ///      just above it, and fails if any limit settles the job without the attestation.
    function _assertNoSilentDropUnderGasPressure(uint256 jobId) internal {
        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        (bool ok,) = _tryComplete(jobId, 10_000_000);
        uint256 used = g0 - gasleft();
        assertTrue(ok, "unconstrained completion failed");
        assertEq(reputation.feedbackCount(), 1, "unconstrained completion did not attest");
        vm.revertToState(snap);

        _assertNoSilentDropBetween(jobId, used / 3, used + 20_000, 1_000);
    }

    /// @dev Completes `jobId` under every gas limit in [lo, hi] and fails if any of them settles the
    ///      job without the attestation, or if none of them settles it at all.
    function _assertNoSilentDropBetween(uint256 jobId, uint256 lo, uint256 hi, uint256 step) internal {
        uint256 attested;
        for (uint256 gasLimit = lo; gasLimit <= hi; gasLimit += step) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = _tryComplete(jobId, gasLimit);
            if (ok) {
                assertEq(reputation.feedbackCount(), 1, "settled without attesting");
                attested++;
            }
            vm.revertToState(snap);
        }
        assertGt(attested, 0, "no gas limit in the sweep settled the job");
    }
}

/// @notice DefigentReputationHookV2 against the real ERC-8183 core (UUPS proxy) and
///         ERC-8004 registry doubles.
contract DefigentReputationHookV2Test is HookV2Fixture {
    // ──────────────────── Attestation ────────────────────

    function test_complete_OwnerBoundProviderAttestsBudgetAndDeliverable() public {
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationAttested(
            jobId, AGENT_ID, client, provider, address(usdc), int128(int256(BUDGET)), 6, DELIVERABLE
        );
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 1);
        MockReputationRegistry.Feedback memory fb = reputation.feedbackAt(0);
        assertEq(fb.client, address(hook));
        assertEq(fb.agentId, AGENT_ID);
        assertEq(fb.value, int128(int256(BUDGET)));
        assertEq(fb.valueDecimals, 6);
        assertEq(fb.tag1, "erc-8183-job");
        assertEq(fb.tag2, "escrow-settled");
        assertEq(fb.endpoint, ENDPOINT);
        assertEq(fb.feedbackURI, "");
        assertEq(fb.feedbackHash, DELIVERABLE);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_complete_AgentWalletBoundProviderAttests() public {
        identity.setAgent(AGENT_ID, stranger, provider);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        _complete(jobId);

        assertEq(reputation.feedbackCount(), 1);
        assertEq(reputation.feedbackAt(0).agentId, AGENT_ID);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_complete_UnsetAgentWalletStillBindsOwner() public {
        identity.setAgent(AGENT_ID, provider, address(0));
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        _complete(jobId);

        assertEq(reputation.feedbackCount(), 1);
    }

    function test_complete_BudgetAtRegistryBoundAttests() public {
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), REGISTRY_VALUE_BOUND);

        _complete(jobId);

        assertEq(reputation.feedbackCount(), 1);
        assertEq(reputation.feedbackAt(0).value, int128(int256(REGISTRY_VALUE_BOUND)));
    }

    // ──────────────────── Farm fix: binding and self-dealing ────────────────────

    function test_complete_UnboundAgentIdSkipsButPaysProvider() public {
        identity.setAgent(AGENT_ID, stranger, stranger);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.ProviderNotBound);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_complete_NonexistentAgentIdSkipsButPaysProvider() public {
        uint256 unknownAgent = 999_999;
        uint256 jobId = _submittedJob(unknownAgent, address(usdc), BUDGET);

        _expectSkipped(jobId, unknownAgent, DefigentReputationHookV2.Eligibility.ProviderNotBound);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_complete_ClientControllingAgentIsSelfDealing() public {
        identity.setAgent(AGENT_ID, client, provider);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.SelfDealing);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_complete_EvaluatorControllingAgentIsSelfDealing() public {
        identity.setAgent(AGENT_ID, provider, evaluator);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.SelfDealing);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    // ──────────────────── Other skips ────────────────────

    function test_complete_NoAgentIdSkips() public {
        uint256 jobId = _submittedJob(0, address(usdc), BUDGET);

        _expectSkipped(jobId, 0, DefigentReputationHookV2.Eligibility.NoAgentId);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_complete_ZeroBudgetSkips() public {
        uint256 jobId = _createJob(AGENT_ID);
        _submit(jobId, DELIVERABLE); // an Open job with no budget can be submitted without funding

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.ZeroBudget);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        assertEq(hook.deliverableOf(jobId), bytes32(0));
    }

    function test_complete_BudgetAboveRegistryBoundSkips() public {
        uint256 budget = REGISTRY_VALUE_BOUND + 1;
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), budget);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.BudgetTooLarge);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), budget);
    }

    function test_complete_RevertingDecimalsSkips() public {
        _assertInvalidDecimalsSkipped(MockOddDecimalsToken.Mode.Reverts);
    }

    function test_complete_DecimalsAboveEighteenSkips() public {
        _assertInvalidDecimalsSkipped(MockOddDecimalsToken.Mode.TooLarge);
    }

    function test_complete_EmptyDecimalsReturnSkips() public {
        _assertInvalidDecimalsSkipped(MockOddDecimalsToken.Mode.Empty);
    }

    function _assertInvalidDecimalsSkipped(MockOddDecimalsToken.Mode mode) internal {
        MockOddDecimalsToken token = _oddToken(mode);
        uint256 jobId = _submittedJob(AGENT_ID, address(token), BUDGET);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.InvalidDecimals);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(token), BUDGET);
    }

    // ──────────────────── Settlement is never blocked ────────────────────

    function test_complete_RegistryRevertKeepsSettlement() public {
        reputation.setShouldRevert(true);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        vm.expectEmit(true, true, false, true, address(hook));
        emit AttestationFailed(jobId, AGENT_ID);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_reject_WritesNoFeedback() public {
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        vm.prank(evaluator);
        core.reject(jobId, bytes32("rejected"), "");

        assertEq(reputation.feedbackCount(), 0);
        assertEq(usdc.balanceOf(client), BUDGET);
        assertEq(usdc.balanceOf(provider), 0);
    }

    // ──────────────────── Gas pressure ────────────────────

    function test_complete_GasStarvationNeverDropsAttestation() public {
        reputation.setExtraSlots(2); // a heavier registry call widens the window a starved call could hide in
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        _assertNoSilentDropUnderGasPressure(jobId);
    }

    function test_complete_RegistryRevertUnderTightGasRevertsInsteadOfSkipping() public {
        reputation.setShouldRevert(true);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        // enough gas to settle, but not enough to hand the registry its full gas budget
        (bool ok, bytes memory ret) = _tryComplete(jobId, 400_000);

        assertFalse(ok);
        assertEq(bytes4(ret), DefigentReputationHookV2.InsufficientGas.selector);
        assertEq(uint8(core.getJob(jobId).status), uint8(ERC8183.JobStatus.Submitted));
    }

    function test_complete_GasBurningIdentityRegistryIsBounded() public {
        identity.setBurnGas(true);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.ProviderNotBound);
        (bool ok,) = _tryComplete(jobId, 2_000_000);

        assertTrue(ok);
        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    // ──────────────────── Payout routing and claims ────────────────────

    function test_complete_PayoutBackToClientIsSelfDealing() public {
        uint256 jobId = _createJob(AGENT_ID);
        vm.prank(provider);
        core.setPayoutReceiver(jobId, client);
        _fund(jobId, address(usdc), BUDGET);
        _submit(jobId, DELIVERABLE);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.SelfDealing);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        assertEq(usdc.balanceOf(client), BUDGET); // the budget went straight back to the client
    }

    function test_complete_PayoutToEvaluatorIsSelfDealing() public {
        uint256 jobId = _createJob(AGENT_ID);
        vm.prank(provider);
        core.setPayoutReceiver(jobId, evaluator);
        _fund(jobId, address(usdc), BUDGET);
        _submit(jobId, DELIVERABLE);

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.SelfDealing);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        assertEq(usdc.balanceOf(evaluator), BUDGET);
    }

    function test_complete_PayoutToThirdPartyAttests() public {
        uint256 jobId = _createJob(AGENT_ID);
        vm.prank(provider);
        core.setPayoutReceiver(jobId, stranger); // e.g. the agent's treasury
        _fund(jobId, address(usdc), BUDGET);
        _submit(jobId, DELIVERABLE);

        _complete(jobId);

        assertEq(reputation.feedbackCount(), 1);
        assertEq(usdc.balanceOf(stranger), BUDGET);
    }

    function test_complete_AfterApprovedMilestoneAttestsFullBudget() public {
        uint256 jobId = _createJob(AGENT_ID);
        _fund(jobId, address(usdc), BUDGET);
        vm.prank(provider);
        core.submitClaim(jobId, BUDGET / 2, MILESTONE, "");
        vm.prank(evaluator);
        core.approveClaim(jobId, BUDGET / 2, MILESTONE, "");
        _submit(jobId, DELIVERABLE);

        _complete(jobId);

        assertEq(reputation.feedbackCount(), 1);
        assertEq(reputation.feedbackAt(0).value, int128(int256(BUDGET)));
        assertEq(reputation.feedbackAt(0).feedbackHash, DELIVERABLE);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    function test_complete_BindingIsCheckedAtCompletion() public {
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);
        identity.setAgent(AGENT_ID, stranger, address(0)); // agent transferred away after submit

        _expectSkipped(jobId, AGENT_ID, DefigentReputationHookV2.Eligibility.ProviderNotBound);
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 0);
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    // ──────────────────── Deliverable bookkeeping ────────────────────

    function test_submit_RecordsDeliverable() public {
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);

        assertEq(hook.deliverableOf(jobId), DELIVERABLE);
    }

    function test_complete_UsesFinalSubmitDeliverableAfterMilestoneClaim() public {
        uint256 jobId = _createJob(AGENT_ID);
        _fund(jobId, address(usdc), BUDGET);
        vm.prank(provider);
        core.submitClaim(jobId, BUDGET / 2, MILESTONE, "");
        assertEq(hook.deliverableOf(jobId), bytes32(0)); // milestone claims are not recorded

        _submit(jobId, DELIVERABLE); // supersedes the pending claim
        _complete(jobId);

        assertEq(reputation.feedbackCount(), 1);
        assertEq(reputation.feedbackAt(0).feedbackHash, DELIVERABLE);
        assertEq(reputation.feedbackAt(0).value, int128(int256(BUDGET)));
        _assertSettled(jobId, address(usdc), BUDGET);
    }

    // ──────────────────── Preflight ────────────────────

    function test_eligibility_PreflightBeforeFunding() public {
        uint256 jobId = _createJob(AGENT_ID);
        vm.prank(provider);
        core.setBudget(jobId, address(usdc), BUDGET, "");

        (DefigentReputationHookV2.Eligibility status, uint8 valueDecimals) = hook.eligibility(jobId);
        assertEq(uint8(status), uint8(DefigentReputationHookV2.Eligibility.Eligible));
        assertEq(valueDecimals, 6);

        identity.setAgent(AGENT_ID, stranger, stranger);
        (status, valueDecimals) = hook.eligibility(jobId);
        assertEq(uint8(status), uint8(DefigentReputationHookV2.Eligibility.ProviderNotBound));
        assertEq(valueDecimals, 0);
    }

    function test_eligibility_ReportsJobsOnOtherHooks() public {
        vm.prank(client);
        uint256 jobId =
            core.createJob(provider, evaluator, uint48(block.timestamp + 1 days), "no hook", address(0), AGENT_ID);

        (DefigentReputationHookV2.Eligibility status, uint8 valueDecimals) = hook.eligibility(jobId);
        assertEq(uint8(status), uint8(DefigentReputationHookV2.Eligibility.NotThisHook));
        assertEq(valueDecimals, 0);
    }

    // ──────────────────── Access control and wiring ────────────────────

    function test_beforeAction_RevertsWhenCallerIsNotEscrow() public {
        vm.expectRevert(DefigentReputationHookV2.NotEscrow.selector);
        vm.prank(stranger);
        hook.beforeAction(1, ERC8183.submit.selector, "");
    }

    function test_afterAction_RevertsWhenCallerIsNotEscrow() public {
        vm.expectRevert(DefigentReputationHookV2.NotEscrow.selector);
        vm.prank(stranger);
        hook.afterAction(1, ERC8183.complete.selector, "");
    }

    function test_afterAction_IgnoresOtherSelectors() public {
        vm.recordLogs();
        vm.prank(address(core));
        hook.afterAction(1, ERC8183.fund.selector, abi.encode(client, bytes("")));

        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(hook.deliverableOf(1), bytes32(0));
    }

    function test_selectors_MatchCore() public view {
        // the hook hardcodes these selectors; they must match the core it is attached to
        assertEq(ERC8183.submit.selector, bytes4(keccak256("submit(uint256,bytes32,bytes)")));
        assertEq(ERC8183.complete.selector, bytes4(keccak256("complete(uint256,bytes32,bytes)")));
        assertEq(address(hook.identity()), address(identity));
    }

    function test_supportsInterface_AdvertisesHookAndERC165() public view {
        assertTrue(hook.supportsInterface(type(IERC8183Hook).interfaceId));
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
        assertFalse(hook.supportsInterface(0xffffffff));
    }

    function test_constructor_StoresWiring() public view {
        assertEq(hook.escrow(), address(core));
        assertEq(address(hook.reputation()), address(reputation));
        assertEq(address(hook.identity()), address(identity));
        assertEq(hook.endpoint(), ENDPOINT);
    }

    function test_constructor_RevertsWhenEscrowHasNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(DefigentReputationHookV2.NotAContract.selector, stranger));
        new DefigentReputationHookV2(stranger, address(reputation), ENDPOINT);
    }

    function test_constructor_RevertsWhenReputationHasNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(DefigentReputationHookV2.NotAContract.selector, stranger));
        new DefigentReputationHookV2(address(core), stranger, ENDPOINT);
    }

    function test_constructor_RevertsWhenIdentityHasNoCode() public {
        MockReputationRegistry orphan = new MockReputationRegistry(stranger);
        vm.expectRevert(abi.encodeWithSelector(DefigentReputationHookV2.NotAContract.selector, stranger));
        new DefigentReputationHookV2(address(core), address(orphan), ENDPOINT);
    }

    // ──────────────────── Fuzz ────────────────────

    function testFuzz_complete_ValueTracksBudget(uint256 budget) public {
        budget = bound(budget, 1, type(uint256).max);
        uint256 jobId = _submittedJob(AGENT_ID, address(usdc), budget);

        _complete(jobId);

        if (budget <= REGISTRY_VALUE_BOUND) {
            assertEq(reputation.feedbackCount(), 1);
            assertEq(reputation.feedbackAt(0).value, int128(int256(budget)));
            assertEq(reputation.feedbackAt(0).valueDecimals, 6);
        } else {
            assertEq(reputation.feedbackCount(), 0);
        }
        _assertSettled(jobId, address(usdc), budget);
    }
}

/// @notice The gas margin, measured with cold accounts: setUp runs as its own transaction, so the
///         registry, identity and token are cold when the test starts, as on a real completion.
contract DefigentReputationHookV2ColdGasTest is HookV2Fixture {
    // a callee handed its whole cap enters with at least this much less (call dispatch)
    uint256 constant STRICT_SLACK = 2_000;

    uint256 jobId;

    function setUp() public override {
        super.setUp();
        // callees that fail exactly when they were handed less than (almost) their whole gas cap
        identity.setAgent(AGENT_ID, provider, address(0)); // bound through ownerOf only
        identity.setMinEntryGas(hook.VIEW_GAS() - STRICT_SLACK);
        reputation.setMinEntryGas(hook.FEEDBACK_GAS() - STRICT_SLACK);
        jobId = _submittedJob(AGENT_ID, address(usdc), BUDGET);
    }

    /// If the margin in _requireFullGasCap were too small, some gas limit would starve a callee yet
    /// pass the check, and the job would settle with a skip or a failure instead of reverting.
    function test_complete_StarvedStrictCalleesNeverSettleSilently() public {
        _assertNoSilentDropBetween(jobId, 300_000, 1_200_000, 1_000);
    }
}
