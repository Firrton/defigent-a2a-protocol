# Deployment Defigent — ERC-8183 en Monad mainnet (chainId 143)

Primer deployment de ERC-8183 (Agentic Commerce) en Monad. Fuente canónica:
https://github.com/erc-8183/base-contracts (MIT). Deploy vía scripts/deploy_8183_monad.py.

- Proxy: 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65
- Impl:  0xe28ed7523e2c8291d690ce1a70a9618d75af81d9
- Fees: 0/0 bps al deploy (captación); ajustables por admin
- Payment token: USDC nativo Monad 0x754704Bc059F8C67012fEd69BC8A327a5aafb603
- Admin/treasury: 0x940ecB27d8f4F7009c8BC12969496E9639717638 (Defigent, agentId 10331)

El canal de negociación de los jobs es el inbox A2A estándar de Defigent
(/inbox, EIP-712 firmado). El contrato solo ejecuta el escrow — la mensajería
vive en el protocolo A2A (ver docs/erc8183-port-monad.md).

## Reputation Hook v2 (`DefigentReputationHookV2`)

**Status:** source, tests and deploy script are in this repo; **not deployed yet**. Hook v1
(`DefigentReputationHook`, `0x03D516e52FD64E2D19A817498f941D7DEa452cD6`) stays whitelisted
until the runbook below runs.

### Why v1 has to go

v1 writes +10 ERC-8004 feedback to `job.providerAgentId` on every completion. The client sets
`providerAgentId` freely (`createJob`/`setProvider`) and nothing ties it to the provider, and an
Open job with zero budget can be submitted and completed without funding. Anyone with two
wallets could attest any agentId for gas only.

### What v2 does

- **Binding.** Attests only if `job.provider` is `ownerOf(agentId)` or `getAgentWallet(agentId)`
  on the ERC-8004 Identity Registry. The registry address is read from
  `reputation.getIdentityRegistry()`. The binding is checked at completion, and the registry
  clears `agentWallet` when the agent NFT is transferred.
- **Self-dealing.** Skips when the client or the evaluator is the agent's owner or agent wallet.
  It also skips when the payout goes back to the client or the evaluator (the payout goes to
  `payoutReceiver`, or to the provider when that is unset). This is narrower than the registry's
  own "Self-feedback not allowed" rule, which checks the owner and ERC-721 approvals/operators
  but not the agent wallet: an approved operator acting as client passes the hook.
- **Value = budget.** `value` is the job's full `budget` in payment-token units, even when
  milestones settled part of it earlier. `valueDecimals` is set to the token's decimals
  (USDC: 6).
  - A zero budget writes no feedback.
  - A budget above `1e38` (the registry's bound) writes no feedback.
- **Deliverable.** Stores the `deliverable` passed to `submit` and writes it as `feedbackHash` on
  `complete`. `feedbackURI` stays empty.
- **Gas and failures.**
  - **Capped calls.** Every registry and token call runs with a gas cap: `FEEDBACK_GAS` = 500k
    for `giveFeedback` and `VIEW_GAS` = 100k for each read. On Monad, a first feedback costs
    about 235k and a cold read about 27k.
  - **A callee failure never blocks settlement.** This covers a registry or token that reverts,
    returns garbage or exhausts its cap. The job completes and the hook emits
    `AttestationSkipped(jobId, agentId, reason)` or `AttestationFailed(jobId, agentId)`.
  - **Too little gas reverts the transaction.** If the transaction cannot hand those calls their
    full cap, a failure reverts with `InsufficientGas()` instead of being recorded. A low gas
    limit can therefore never settle a job while silently dropping its attestation.
    The gas-limit sweeps prove it:
    - `test_complete_GasStarvationNeverDropsAttestation` (unit);
    - `test_fork_GasPressure*` (fork);
    - `test_complete_StarvedStrictCalleesNeverSettleSilently`, which uses callees that fail
      whenever they get less than their full cap. It fails with a margin of 8k and passes from
      12k; the hook uses 50k.
  - **Monad's `eth_estimateGas` returns a limit that attests.** monad-rpc binary-searches the
    lowest limit that succeeds, and with v2 every success includes the attestation.
  - **Size gas limits on cold numbers.** On Monad, cold accesses dominate the cost. On a fork
    (2026-10-23), with every account cold as on a real transaction, the lowest limit that settled
    a completion was:

    | Case | Call gas | ≈ Transaction gas |
    |---|---|---|
    | First feedback | about 588k | about 610k |
    | Repeat feedback | about 506k | about 528k |

    Either use the estimate or a fixed limit of at least 700k. A limit that is too low reverts,
    and Monad still charges the whole limit.
  - **Escrow upgrades.** The hook decodes `getJob` with the deployed `Job` layout, and v1 does the
    same.
    - Appending fields (the core's own convention) is safe.
    - Inserting or reordering fields could make the hook misread jobs or revert.

    Detach the hook with `batchDetachHook` before such an upgrade.
  - **Cached identity registry.** The Identity Registry is read from the reputation registry
    once, at construction. If the reputation registry is ever re-pointed to another identity
    registry, deploy a new hook.
- **Preflight.** `eligibility(jobId)` runs the same checks before funding, as soon as the provider,
  agentId and budget are set. It also returns `NotThisHook` for a job that does not use this
  hook. The checks run again at completion, and the registry call itself can still fail. Like
  completion, it reverts with `InsufficientGas` when given too little gas.
- **Endpoint.** Passed to the constructor; v1 hardcoded the ngrok URL. The hook has no owner, no
  admin and no upgrade path, so a new endpoint means a new deployment.
- **Unchanged.** Tags stay `erc-8183-job` / `escrow-settled`, and the feedback `clientAddress`
  is still the hook. Every attestation emits `ReputationAttested` with client, provider and
  payment token.

### Reading v2 reputation

`getSummary(agentId, [hookV2], "erc-8183-job", "")` returns two things:
- `count`: the number of attested jobs;
- `summaryValue`: the average budget, in the mode of the decimals (6 for USDC).

Always pass the hook address in `clientAddresses`; ERC-8004 rejects unfiltered summaries because
of Sybil spam. Do not mix v1 and v2. They are different client addresses, and v1 values are
`10` with 0 decimals.

### Residual risk

- **Wash trading still works.** Whoever controls the agent can run jobs with a helper wallet as
  client and evaluator, and the hook cannot tell a helper from an independent client.
  - **Capital is no barrier.** The capital comes back when the job settles. With a contract
    wallet the whole job (fund, submit, complete) fits in one transaction, so the capital can
    even be flash-borrowed. A high `value` is therefore not proof that the work happened.
  - **What v2 does guarantee.** The agent's own owner or wallet must act as provider. The cases
    visible on-chain are blocked: the same key on both sides, and a payout that goes straight
    back to the client or the evaluator.
  - **What readers should do.** Weight by distinct clients (`ReputationAttested.client`) and
    their history, not by value alone.
- **Units follow the payment token.** `value` is denominated in the job's payment token. Only
  USDC is allowlisted. Allowlisting a token with other units would mix units inside one
  `getSummary`, so revisit the tags first (for example, one tag per token).
- **The registries are upgradeable.** The ERC-8004 registries are upgradeable proxies run by
  their deployer, and the hook trusts them. The gas caps bound what a bad upgrade can burn.

### Retiring v1

**Dewhitelisting alone does not close v1.** `whitelistedHooks` is only checked in `createJob`.
Dewhitelisting v1 stops new jobs from using it, but every job that already points at v1 keeps
calling it until it finishes.

**The reserved-job farm.** While v1 is still whitelisted, anyone can reserve jobs on it: no
provider, zero budget, far-future expiry. After the dewhitelist, the reserver can:
1. set any agentId on the job;
2. submit and complete it;
3. watch v1 write +10 to that agent.

This is fork-verified in `test_fork_DewhitelistAloneLeavesReservedV1JobsFarmable`.

**The migration therefore detaches every unfinished v1 job, whatever its expiry**, in two phases:
1. `run()` dewhitelists v1 and detaches the open v1 jobs it can see.
2. `detachV1Jobs()`, once phase 1 is mined, detaches the jobs created in between and asserts
   that none is left. No new v1 job can appear after the dewhitelist.

`test_fork_DetachClosesReservedV1Jobs` covers it.

**The window between the phases.** Some jobs can be reserved after the phase-1 simulation but
before its dewhitelist is mined. Each of those can still write one v1 entry if it is completed
before phase 2 lands. The entries are filed under v1's client address, which v2 readers do not
query.

**Closing the window completely.** Pause the escrow around the migration, as shown in the
runbook. `createJob`, `setProvider`, `submit` and `complete` all stop while it is paused.
`setHookWhitelist` and `batchDetachHook` keep working, and the scan only reads. Pausing also
stops every other job, so run both phases back to back.

On 2026-10-23, seven Open jobs pointed at v1 (1, 2, 3, 6, 7, 8 and 20). All of them were already
expired.

### Runbook (from the server)

1. Build: `cd contracts-8183 && forge build --force`. The libs are pinned in `foundry.lock`.
   `--force` avoids a stale cache, which makes `forge script` fail with "Could not find target
   contract".
   - Optional: to close the window between the phases, pause the escrow first with
     `cast send 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65 "pause()"` (admin key). Unpause it with
     `"unpause()"` after step 4.
   - If a broadcast is interrupted, rerun the same command with `--resume`. Never rerun phase 1
     without it: that would deploy a second hook, and reputation would be split across two client
     addresses.
2. Simulate phase 1. This needs no key and sends nothing:
   ```
   HOOK_V2_ENDPOINT=https://<stable public inbox URL> DEWHITELIST_V1=true \
     forge script script/DeployReputationHookV2.s.sol --rpc-url "$QUICKNODE_URL" \
     --sender 0x940ecB27d8f4F7009c8BC12969496E9639717638
   ```
   Confirm that the output:
   - says "Script ran successfully";
   - lists the open v1 jobs it would detach;
   - shows the estimated cost. On 2026-10-23 that was about 1.83M gas, roughly 0.37 MON at
     202 gwei.
3. Broadcast phase 1. Export `DEFIGENT_PRIVATE_KEY` (0x-prefixed; the script refuses any key
   that is not the escrow admin) and rerun the same command with `--broadcast`.
4. Once phase 1 is mined, simulate phase 2 with the same flags (no endpoint needed):
   `forge script script/DeployReputationHookV2.s.sol --sig "detachV1Jobs()" ...`.
   If it lists open v1 jobs, broadcast it. It must end with "open v1 jobs left: 0".
5. Verify:
   - `cast call 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65 "whitelistedHooks(address)(bool)" <v2>`
     returns true.
   - The same call for v1 returns false.
6. Repoint the off-chain references listed below to v2.
7. Run one paid dogfood job through v2. Then check
   `getSummary(<agentId>, [<v2>], "erc-8183-job", "")`.

### Off-chain references to update after the deploy

- `public/jobs.html`:
  - the "Reputation hook" address;
  - the "Verified: value 10" text.
- `scripts/dogfood_e2e.py` and `scripts/deploy_8183_selftest.py` hardcode v1 for new jobs.
  `deploy_8183_selftest.py` also sends `complete()` with a fixed 600k gas. That is below the
  ~610k a first v2 attestation needs, so raise it to at least 700k.
- `docs/attestation-verified.md` is the historical v1 record. Its claim that feedback cannot be
  written without a real settlement was false for v1.
- `http_server.mjs` `peerReputation()` does not work today:
  - **Why.** It builds the `readAllFeedback` selector with SHA3-256 (`0x75c10178`) instead of
    Keccak-256 (`0xd9d84224`). It also decodes the result as an array of structs, while the
    registry returns seven parallel arrays.
  - **Effect.** It always returns `{0, 0}`, so the `RICH` tier is unreachable.
  - **When fixing it.** Filter by trusted clients (the v2 hook) and normalize by
    `valueDecimals`. v2 values are budgets: one 0.01 USDC job reads as 10000.
- `data/erc8183.json` has no hook entry. Record v2 there when it is deployed.
