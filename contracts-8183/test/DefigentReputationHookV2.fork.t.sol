// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ERC8183} from "../contracts/ERC8183.sol";
import {DefigentReputationHookV2} from "../contracts/DefigentReputationHookV2.sol";

interface IReputationSummary {
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/// @notice Shared fixture for tests against the live Monad deployments (escrow proxy, ERC-8004
///         registries, native USDC) on a fork. Every test is skipped unless MONAD_RPC_URL is set:
///           MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-path test/DefigentReputationHookV2.fork.t.sol
abstract contract HookV2ForkFixture is Test {
    address constant ESCROW = 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant HOOK_V1 = 0x03D516e52FD64E2D19A817498f941D7DEa452cD6;
    address constant WALLET_A = 0x940ecB27d8f4F7009c8BC12969496E9639717638; // escrow admin, owner of agent 10331
    address constant WALLET_B = 0x54d3D450cD6519bF3fC0DD3396831eF3Ab8be957; // owner of agent 10407
    uint256 constant AGENT_A = 10331;
    uint256 constant AGENT_B = 10407;
    uint256 constant BUDGET = 10_000; // 0.01 USDC
    bytes32 constant DELIVERABLE = keccak256("fork deliverable");
    string constant ENDPOINT = "https://defigent.example/inbox";

    // ERC-8004 ReputationRegistryUpgradeable 2.0.0
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event AttestationSkipped(
        uint256 indexed jobId, uint256 indexed agentId, DefigentReputationHookV2.Eligibility reason
    );

    bool forked;
    ERC8183 core = ERC8183(ESCROW);
    DefigentReputationHookV2 hook;

    function setUp() public virtual {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        hook = new DefigentReputationHookV2(ESCROW, REPUTATION, ENDPOINT);
        vm.prank(WALLET_A);
        core.setHookWhitelist(address(hook), true);
    }

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function _submittedJob(uint256 agentId) internal returns (uint256 jobId) {
        vm.prank(WALLET_A);
        jobId = core.createJob(WALLET_B, WALLET_A, uint48(block.timestamp + 1 days), "fork job", address(hook), agentId);
        vm.prank(WALLET_B);
        core.setBudget(jobId, USDC, BUDGET, "");
        vm.startPrank(WALLET_A);
        IERC20(USDC).approve(ESCROW, BUDGET);
        core.fund(jobId, USDC, BUDGET, "");
        vm.stopPrank();
        vm.prank(WALLET_B);
        core.submit(jobId, DELIVERABLE, "");
    }

    function _summary(uint256 agentId) internal view returns (uint64 count, int128 value, uint8 decimals) {
        address[] memory clients = new address[](1);
        clients[0] = address(hook);
        return IReputationSummary(REPUTATION).getSummary(agentId, clients, "erc-8183-job", "");
    }

    function _tryComplete(uint256 jobId, uint256 gasLimit) internal returns (bool ok) {
        vm.prank(WALLET_A);
        (ok,) = ESCROW.call{gas: gasLimit}(abi.encodeCall(ERC8183.complete, (jobId, bytes32("approved"), "")));
    }
}

/// @notice DefigentReputationHookV2 against the live Monad deployments.
contract DefigentReputationHookV2ForkTest is HookV2ForkFixture {
    function test_fork_WiresToLiveRegistries() public onlyFork {
        assertEq(address(hook.identity()), IDENTITY);
        assertTrue(core.whitelistedHooks(address(hook)));
    }

    function test_fork_BoundProviderAttestsBudgetAndDeliverable() public onlyFork {
        uint256 jobId = _submittedJob(AGENT_B);
        uint256 balanceBefore = IERC20(USDC).balanceOf(WALLET_B);

        vm.expectEmit(true, true, true, true, REPUTATION);
        emit NewFeedback(
            AGENT_B,
            address(hook),
            1,
            int128(int256(BUDGET)),
            6,
            "erc-8183-job",
            "erc-8183-job",
            "escrow-settled",
            ENDPOINT,
            "",
            DELIVERABLE
        );
        vm.prank(WALLET_A);
        core.complete(jobId, bytes32("approved"), "");

        (uint64 count, int128 value, uint8 decimals) = _summary(AGENT_B);
        assertEq(count, 1);
        assertEq(value, int128(int256(BUDGET)));
        assertEq(decimals, 6);
        assertEq(IERC20(USDC).balanceOf(WALLET_B), balanceBefore + BUDGET);
    }

    function test_fork_AgentIdNotOwnedByProviderIsNotAttested() public onlyFork {
        // the v1 farm: the client points the job at an agent the provider does not control
        uint256 jobId = _submittedJob(AGENT_A);
        uint256 balanceBefore = IERC20(USDC).balanceOf(WALLET_B);

        vm.expectEmit(true, true, false, true, address(hook));
        emit AttestationSkipped(jobId, AGENT_A, DefigentReputationHookV2.Eligibility.ProviderNotBound);
        vm.prank(WALLET_A);
        core.complete(jobId, bytes32("approved"), "");

        (uint64 count,,) = _summary(AGENT_A);
        assertEq(count, 0);
        assertEq(IERC20(USDC).balanceOf(WALLET_B), balanceBefore + BUDGET);
    }

    /// @dev A job reserved on v1 before the dewhitelist: far expiry, no provider, zero budget.
    ///      Returns the v1 feedback count of AGENT_A after the reserver tries to farm it.
    function _farmReservedV1Job(bool detach) internal returns (uint64 before, uint64 afterFarm) {
        address reserver = makeAddr("reserver");
        address farmEvaluator = makeAddr("farm-evaluator");
        address farmProvider = makeAddr("farm-provider");
        address[] memory v1 = new address[](1);
        v1[0] = HOOK_V1;
        (before,,) = IReputationSummary(REPUTATION).getSummary(AGENT_A, v1, "", "");

        vm.prank(reserver);
        uint256 jobId = core.createJob(address(0), farmEvaluator, type(uint48).max, "reserved", HOOK_V1, 0);

        vm.startPrank(WALLET_A);
        core.setHookWhitelist(HOOK_V1, false);
        if (detach) {
            uint256[] memory ids = new uint256[](1);
            ids[0] = jobId;
            core.batchDetachHook(ids);
        }
        vm.stopPrank();

        vm.prank(reserver);
        core.setProvider(jobId, farmProvider, AGENT_A); // an agent nobody in this job controls
        vm.prank(farmProvider);
        core.submit(jobId, bytes32(0), "");
        vm.prank(farmEvaluator);
        core.complete(jobId, bytes32(0), "");

        (afterFarm,,) = IReputationSummary(REPUTATION).getSummary(AGENT_A, v1, "", "");
    }

    function test_fork_DewhitelistAloneLeavesReservedV1JobsFarmable() public onlyFork {
        (uint64 before, uint64 afterFarm) = _farmReservedV1Job(false);
        assertEq(afterFarm, before + 1);
    }

    function test_fork_DetachClosesReservedV1Jobs() public onlyFork {
        (uint64 before, uint64 afterFarm) = _farmReservedV1Job(true);
        assertEq(afterFarm, before);
    }
}

/// @notice Gas pressure on the live contracts, measured cold: setUp runs as its own transaction and
///         prepares the job, so the escrow, token, hook and registries are all cold when the test
///         starts, as on a real completion. Each sweep step reverts to that cold snapshot.
abstract contract HookV2ForkGasFixture is HookV2ForkFixture {
    uint256 jobId;
    uint64 countBefore;

    /// @dev Completes `jobId` under every gas limit from a third of an unconstrained run's usage up to
    ///      12.5% above it (this covers what gas estimators return), and fails if any limit settles
    ///      the job without the live registry recording the attestation.
    function _assertNoSilentDropUnderGasPressure() internal {
        uint256 snap = vm.snapshotState(); // first statement: nothing is warm yet
        uint256 g0 = gasleft();
        assertTrue(_tryComplete(jobId, 10_000_000), "unconstrained completion failed");
        uint256 used = g0 - gasleft();
        vm.revertToState(snap);

        uint256 attested;
        uint256 lowest;
        for (uint256 gasLimit = used / 3; gasLimit <= used + used / 8; gasLimit += 2_000) {
            snap = vm.snapshotState();
            if (_tryComplete(jobId, gasLimit)) {
                (uint64 count,,) = _summary(AGENT_B);
                assertEq(count, countBefore + 1, "settled without attesting");
                if (attested++ == 0) lowest = gasLimit;
            }
            vm.revertToState(snap);
        }
        assertGt(attested, 0, "no gas limit in the sweep settled the job");
        // call gas, i.e. without the transaction's intrinsic gas
        console2.log("complete() call gas: used unconstrained / lowest that settled:", used, lowest);
    }
}

contract DefigentReputationHookV2ForkFirstFeedbackGasTest is HookV2ForkGasFixture {
    function setUp() public override {
        super.setUp();
        if (!forked) return;
        jobId = _submittedJob(AGENT_B);
        (countBefore,,) = _summary(AGENT_B);
    }

    function test_fork_GasPressureNeverDropsFirstAttestation() public onlyFork {
        _assertNoSilentDropUnderGasPressure();
    }
}

contract DefigentReputationHookV2ForkRepeatFeedbackGasTest is HookV2ForkGasFixture {
    function setUp() public override {
        super.setUp();
        if (!forked) return;
        uint256 first = _submittedJob(AGENT_B);
        vm.prank(WALLET_A);
        core.complete(first, bytes32("approved"), "");
        jobId = _submittedJob(AGENT_B);
        (countBefore,,) = _summary(AGENT_B);
    }

    function test_fork_GasPressureNeverDropsRepeatAttestation() public onlyFork {
        _assertNoSilentDropUnderGasPressure();
    }
}
