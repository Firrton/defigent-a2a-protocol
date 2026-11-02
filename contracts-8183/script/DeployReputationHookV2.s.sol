// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {IERC8183Hook} from "../contracts/IERC8183Hook.sol";
import {
    DefigentReputationHookV2,
    IERC8183JobReader,
    IERC8004ReputationRegistry
} from "../contracts/DefigentReputationHookV2.sol";

interface IEscrowHookAdmin {
    function setHookWhitelist(address hook, bool status) external;

    function batchDetachHook(uint256[] calldata jobIds) external;

    function whitelistedHooks(address hook) external view returns (bool);

    function hasRole(bytes32 role, address account) external view returns (bool);

    function jobCounter() external view returns (uint256);
}

/**
 * @title DeployReputationHookV2
 * @notice Deploys DefigentReputationHookV2 on Monad mainnet and whitelists it on the Defigent
 *         ERC-8183 escrow. With DEWHITELIST_V1=true it also retires the farmable v1 hook in two
 *         phases, because dewhitelisting only blocks NEW jobs: every job that already points at v1
 *         keeps calling it, and anyone can still reserve far-expiry v1 jobs until the dewhitelist
 *         is mined.
 *         1. run(): deploy v2, whitelist it, dewhitelist v1, detach the open v1 jobs visible now.
 *         2. detachV1Jobs(), once phase 1 is mined: detach the v1 jobs created in between and
 *            assert that none is left. No new v1 job can appear after the dewhitelist.
 *
 *         Env: HOOK_V2_ENDPOINT (run only; required, https), DEWHITELIST_V1 (run only; default
 *              false), DEFIGENT_PRIVATE_KEY (optional, 0x-prefixed; must be the escrow admin).
 *
 *         Simulate (no key, nothing is sent):
 *           HOOK_V2_ENDPOINT=https://<public inbox> DEWHITELIST_V1=true \
 *             forge script script/DeployReputationHookV2.s.sol --rpc-url $MONAD_RPC_URL \
 *             --sender 0x940ecB27d8f4F7009c8BC12969496E9639717638
 *           forge script script/DeployReputationHookV2.s.sol --sig "detachV1Jobs()" ...same flags
 *         Broadcast: the same commands with DEFIGENT_PRIVATE_KEY exported, plus --broadcast.
 */
contract DeployReputationHookV2 is Script {
    uint256 constant MONAD_CHAIN_ID = 143;
    address constant ESCROW = 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant HOOK_V1 = 0x03D516e52FD64E2D19A817498f941D7DEa452cD6;
    bytes32 constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint256 constant DETACH_BATCH = 100;

    IEscrowHookAdmin constant escrow = IEscrowHookAdmin(ESCROW);

    /// @notice Phase 1: deploy and whitelist v2; with DEWHITELIST_V1=true, retire v1.
    function run() external returns (DefigentReputationHookV2 hook) {
        string memory endpoint = vm.envString("HOOK_V2_ENDPOINT");
        require(_hasPrefix(endpoint, "https://"), "HOOK_V2_ENDPOINT must be an https URL");
        bool dewhitelistV1 = vm.envOr("DEWHITELIST_V1", false);
        require(
            IERC8004ReputationRegistry(REPUTATION).getIdentityRegistry() == IDENTITY,
            "unexpected identity registry behind the reputation registry"
        );

        _startAdminBroadcast();
        hook = new DefigentReputationHookV2(ESCROW, REPUTATION, endpoint);
        escrow.setHookWhitelist(address(hook), true);
        if (dewhitelistV1) {
            escrow.setHookWhitelist(HOOK_V1, false);
            _detach(_openV1Jobs());
        }
        vm.stopBroadcast();

        require(hook.escrow() == ESCROW, "escrow mismatch");
        require(address(hook.reputation()) == REPUTATION, "reputation mismatch");
        require(address(hook.identity()) == IDENTITY, "identity mismatch");
        require(keccak256(bytes(hook.endpoint())) == keccak256(bytes(endpoint)), "endpoint mismatch");
        require(hook.supportsInterface(type(IERC8183Hook).interfaceId), "hook interface missing");
        require(escrow.whitelistedHooks(address(hook)), "v2 is not whitelisted");
        if (dewhitelistV1) {
            require(!escrow.whitelistedHooks(HOOK_V1), "v1 is still whitelisted");
            require(_openV1Jobs().length == 0, "open v1 jobs left");
        }

        console2.log("DefigentReputationHookV2:", address(hook));
        console2.log("endpoint:", endpoint);
        console2.log("v1 still whitelisted:", escrow.whitelistedHooks(HOOK_V1));
        if (dewhitelistV1) console2.log("next: once this is mined, run detachV1Jobs()");
    }

    /// @notice Phase 2, after the dewhitelist is mined: detach every v1 job that is not finished
    ///         yet, whatever its expiry, and prove that none is left.
    function detachV1Jobs() external {
        require(!escrow.whitelistedHooks(HOOK_V1), "v1 is still whitelisted: run phase 1 first");

        uint256[] memory open = _openV1Jobs();
        if (open.length > 0) {
            _startAdminBroadcast();
            _detach(open);
            vm.stopBroadcast();
        }

        require(_openV1Jobs().length == 0, "open v1 jobs left");
        console2.log("open v1 jobs left: 0");
    }

    function _startAdminBroadcast() internal {
        require(block.chainid == MONAD_CHAIN_ID, "not Monad mainnet");
        uint256 pk = vm.envOr("DEFIGENT_PRIVATE_KEY", uint256(0));
        address broadcaster = pk != 0 ? vm.addr(pk) : msg.sender;
        require(escrow.hasRole(ADMIN_ROLE, broadcaster), "broadcaster lacks ADMIN_ROLE on the escrow");
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
    }

    /// @dev Jobs that point at v1 and are not Completed, Rejected or Expired. Expiry is ignored on
    ///      purpose: a reserved job can carry any expiry, and detaching an expired one is harmless.
    function _openV1Jobs() internal view returns (uint256[] memory ids) {
        uint256 count = escrow.jobCounter();
        ids = new uint256[](count);
        uint256 n;
        for (uint256 jobId = 1; jobId <= count; jobId++) {
            IERC8183JobReader.Job memory job = IERC8183JobReader(ESCROW).getJob(jobId);
            // statuses: 0 Open, 1 Funded, 2 Submitted, then the terminal ones
            if (job.hook == HOOK_V1 && job.status <= 2) {
                console2.log("open v1 job:", jobId, "status:", job.status);
                ids[n++] = jobId;
            }
        }
        assembly ("memory-safe") {
            mstore(ids, n)
        }
    }

    function _detach(uint256[] memory ids) internal {
        for (uint256 start = 0; start < ids.length; start += DETACH_BATCH) {
            uint256 end = start + DETACH_BATCH < ids.length ? start + DETACH_BATCH : ids.length;
            uint256[] memory batch = new uint256[](end - start);
            for (uint256 i = start; i < end; i++) {
                batch[i - start] = ids[i];
            }
            escrow.batchDetachHook(batch);
        }
        console2.log("v1 jobs detached:", ids.length);
    }

    function _hasPrefix(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(prefix);
        if (a.length <= b.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }
}
