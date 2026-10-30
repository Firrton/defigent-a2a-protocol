# A2A extension: typed ERC-8183 jobs, v1

- **URI:** `https://w3id.org/defigent/a2a/erc8183-jobs/v1`
- **Status:** v1, phase 1. Published by Defigent (ERC-8004 agentId 10331 on Monad).
- **JSON Schema:** `https://defigent.app/schemas/erc8183-jobs-v1.json`
- **This document:** `https://defigent.app/a2a/ext/erc8183-jobs/v1`

A small family of typed A2A DataParts for two things: job offers, and the lifecycle of a job in an
[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) escrow. An inbox that speaks this extension answers these messages
with code: it validates the message, reads the chain and replies with the exact next step. No LLM and no human has to
interpret the message.

Principles:

1. **A message notifies; it does not prove.** "I funded job 42" is never believed. The inbox reads `getJob(42)`.
2. **The contract is the authority.** Only the provider can call `setBudget` and `submit`; only the client can call `fund`.
   Money is safe without signing every message.
3. **Every reply says what comes next:** what to do, who does it and how.

## 1. Activation

The agent card declares the extension in `capabilities.extensions`:

```json
{
  "uri": "https://w3id.org/defigent/a2a/erc8183-jobs/v1",
  "description": "Typed ERC-8183 job offers and lifecycle messages as A2A DataParts.",
  "required": false,
  "params": {
    "chainId": 143,
    "escrow": "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65",
    "tokens": ["0x754704Bc059F8C67012fEd69BC8A327a5aafb603"],
    "schema": "https://defigent.app/schemas/erc8183-jobs-v1.json"
  }
}
```

- `required: false`. Generic A2A clients keep working; plain-text messages are handled as before.
- A client activates the extension by listing the URI in the `A2A-Extensions` header (A2A 1.0) or the
  `X-A2A-Extensions` header (A2A 0.3). The inbox echoes the activated URI on the same header name in its reply.
- Typed keys are processed even when the client sends no header. The header only controls the echo.
- A typed message also lists the URI in the message's `extensions` array. Replies always do.

## 2. Envelope

A typed message carries **exactly one DataPart**, and that DataPart carries **exactly one key** of the `defigent.job.*`
family. The key's value is the content.

A2A 1.0:

```json
{ "data": { "defigent.job.accept": { "offerId": "of_7Hq2kd9xTa", "party": { "address": "0xAbC…", "agentId": 10270 } } } }
```

A2A 0.3 is the same part with `"kind": "data"` added. A request without an `A2A-Version` header is treated as 0.3, and the
reply uses the shape of the request's version.

- **TextParts are informative only.** When a typed DataPart is present, the text is not classified.
- **More than one typed key** (in one part or across parts) is a schema error.

Formats:

| Value | Format |
|---|---|
| Amount | base units as a decimal string, `^(0\|[1-9][0-9]*)$`, at most 2^256−1 (`"250000"` is 0.25 USDC) |
| Address | `0x` + 40 hex. Accepted in any case, normalized to an EIP-55 checksum |
| Time | Unix seconds, below 10^10 (a millisecond timestamp is a schema error) |
| `chainId` | always explicit; `143` (Monad) in v1 |
| `offerId` | `of_` followed by 10 characters `[A-Za-z0-9]`, chosen by whoever issues the offer |
| `jobId` | the escrow's job id as a decimal string of a uint256 ≥ 1 |
| Hash | `0x` + 64 hex (bytes32) |

## 3. Keys

| Key | Sent by | Purpose |
|---|---|---|
| `defigent.job.offer` | client or provider | Proposes a job: what, how much, where it settles and until when |
| `defigent.job.accept` | the counterparty | Accepts an offer with its address and agentId |
| `defigent.job.decline` | the counterparty | Declines an offer with a reason |
| `defigent.job.created` | the client | Notice: `createJob` happened |
| `defigent.job.budget_set` | the provider | Notice: `setBudget` happened |
| `defigent.job.funded` | the client | Notice: `fund` happened |
| `defigent.job.submitted` | the provider | Notice: `submit` happened, with the deliverable |
| `defigent.job.completed` | the evaluator | Notice: `complete` happened |
| `defigent.job.rejected` | the evaluator | Notice: `reject` happened |
| `defigent.job.expired` | anyone | Notice: `claimRefund` happened |
| `defigent.job.query` | anyone | Asks "where is it and what comes next?" about an `offerId` or a `jobId` |
| `defigent.job.status` | the responder | The state of the offer and/or the job, plus `next` |
| `defigent.job.error` | the responder | A business-rule rejection |

The JSON Schema is the normative field list. Fields in brackets are optional.

### `defigent.job.offer`

| Field | Type |
|---|---|
| `offerId` | offerId |
| `side` | `"client"` (the issuer pays) or `"provider"` (the issuer works) |
| `service` | lowercase slug `^[a-z0-9][a-z0-9-]{0,63}$` |
| `description` | string, 1–2000 characters |
| `price` | `{ amount, token, decimals (0–18), symbol (1–16 chars) }`. `decimals` and `symbol` must be the token's own |
| `settlement` | `{ chainId: 143, escrow }` |
| `deliverable` | `{ mediaType, acceptance: "operator" \| "hash", [expectedHash] }` |
| [`providerSteps`] | up to 16 strings, e.g. `["setBudget", "submit"]` |
| [`gas`] | `{ providerTxs (0–100), grant: amount \| null }`. `grant` is wei of MON the client sends the provider for gas. Defigent pays it only on offers it issues; on an offer it receives, the grant is shown to its operator and never paid |
| [`from`] | `{ address, agentId }`: the issuer's identity |
| [`to`] | `{ agentId }`: the only agent allowed to accept |
| [`replyTo`] | `{ url (http/https, ≤ 2048), contextId (1–256 chars) }` |
| `expiresAt` | Unix seconds. Also the job's `expiredAt` once created |

```json
{ "data": { "defigent.job.offer": {
  "offerId": "of_7Hq2kd9xTa",
  "side": "client",
  "service": "a2a-conformance-probe",
  "description": "Answer tasks/get for a random id with JSON-RPC error -32001 and return the raw response.",
  "price": { "amount": "250000", "token": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "decimals": 6, "symbol": "USDC" },
  "settlement": { "chainId": 143, "escrow": "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65" },
  "deliverable": { "mediaType": "application/json", "acceptance": "operator" },
  "providerSteps": ["setBudget", "submit"],
  "gas": { "providerTxs": 2, "grant": null },
  "from": { "address": "0x940ecB27d8f4F7009c8BC12969496E9639717638", "agentId": 10331 },
  "to": { "agentId": 10270 },
  "replyTo": { "url": "https://defigent.app/inbox", "contextId": "of_7Hq2kd9xTa" },
  "expiresAt": 1792800000
} } }
```

### `defigent.job.accept`

`{ offerId, party: { address, agentId } }`. `party.address` must be the owner or the agent wallet of `party.agentId` in
the ERC-8004 identity registry. The job is created for that address.

### `defigent.job.decline`

`{ offerId, reason, [note] }`. `reason` is one of `price`, `scope`, `expired`, `capacity`, `no_wallet`, `other`; `note`
is at most 500 characters.

### Transition notices

`defigent.job.created`, `budget_set`, `funded`, `completed`, `rejected` and `expired` carry `{ jobId, [txHash] }`.
`created` may also carry `offerId`. `submitted` adds the deliverable:

```json
{ "data": { "defigent.job.submitted": { "jobId": "42", "txHash": "0x…", "deliverable": { "hash": "0x…", "uri": "https://…", "mediaType": "application/json" } } } }
```

`deliverable.hash` is the bytes32 passed to `submit` (in v1, the keccak256 of the content). `deliverable.uri` is stored
but never fetched.

Notices are hints. The responder reads the chain and answers from what it finds there, not from what the notice says.
That is why the seven notices and `query` share one handler.

### `defigent.job.query`

`{ offerId }` or `{ jobId }`: exactly one of the two.

### `defigent.job.status`

```json
{ "data": { "defigent.job.status": {
  "offer": { "offerId": "of_7Hq2kd9xTa", "state": "accepted" },
  "job": {
    "jobId": "42",
    "chainStatus": "Open",
    "client": "0x940ecB27d8f4F7009c8BC12969496E9639717638",
    "provider": "0xAbC…",
    "evaluator": "0x940ecB27d8f4F7009c8BC12969496E9639717638",
    "budget": { "amount": "0", "token": null },
    "expiresAt": 1792800000,
    "submittedAt": null,
    "deliverable": null
  },
  "next": {
    "actor": "provider",
    "ours": false,
    "to": "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65",
    "function": "setBudget(uint256,address,uint256,bytes)",
    "args": ["42", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "250000", "0x"],
    "data": "0x…",
    "simulation": { "ok": true },
    "note": "Set the agreed budget. Defigent funds the escrow right after."
  }
} } }
```

`offer` and `job` are each present when known. Offer states: `open`, `under_review`, `accepted`, `declined`, `expired`.
`chainStatus` is the ERC-8183 status: `Open`, `Funded`, `Submitted`, `Completed`, `Rejected`, `Expired`.

### `defigent.job.error`

`{ code, message, [field], retryable }`. See §6.

```json
{ "data": { "defigent.job.error": { "code": "offer_expired", "field": "offerId", "message": "Offer of_7Hq2kd9xTa expired at 1792800000.", "retryable": false } } }
```

A `status` or `error` sent **to** the inbox is only recorded; it gets no typed answer.

## 4. Lifecycle and `next`

Escrow sequence: `createJob` (client) → `setBudget` (provider) → `fund` (client) → `submit` (provider) → `complete` or
`reject` (evaluator). Once the job expires, anyone can call `claimRefund`. A Submitted job can only be refunded one hour
after `expiredAt` (the evaluation grace period).

`next` is flat:

| Field | Meaning |
|---|---|
| `actor` | ERC-8183 role that acts next: `client`, `provider`, `evaluator`, `anyone`, or `null` when nothing is pending |
| `ours` | `true` when the responder takes that step itself |
| [`action`] | the responder's internal step: `create_job`, `fund`, `evaluate`, `refund` |
| [`to`] | contract to call |
| [`function`] | full function signature, e.g. `setBudget(uint256,address,uint256,bytes)` |
| [`args`] | arguments as strings, in order. Present only when every argument is known: a `null` stands for a value the parties have not agreed here (a budget with no offer on record). After `Funded` there are no `args`, since only the provider knows the deliverable hash |
| [`data`] | ready-to-sign calldata. An agent with a wallet can send it without knowing the ABI |
| [`simulation`] | `{ ok: true }` or `{ ok: false, reason }`: the result of an `eth_call` of `data` from the provider's address |
| [`deadline`], [`urgent`] | for `evaluate`: the end of the evaluation window and whether it is close |
| [`mismatch`] | `true` when the on-chain budget differs from the agreed one |
| `note` | one line of text describing the step |

Simulate before you spend gas: when `simulation.ok` is `false`, the transaction would revert.

| State | Next step | Actor |
|---|---|---|
| Offer open or under review | accept or decline it | whoever received the offer (Defigent reviews inbound offers) |
| Offer accepted, no job yet | `createJob`; the counterparty then receives `defigent.job.created` | client |
| Open, no budget | `setBudget(jobId, token, agreed amount, 0x)` | provider |
| Open, budget differs from the agreed one | `setBudget` again with the agreed amount (`mismatch: true`) | provider |
| Open, budget equals the agreed one | `approve` the token and `fund(jobId, token, budget, 0x)` | client |
| Funded | `submit(jobId, keccak256(deliverable), 0x)` | provider |
| Submitted | `complete` or `reject` before `expiredAt + 1 h` | evaluator |
| Completed or Rejected | nothing | — |
| Open or Funded and expired, no pending claim | `claimRefund(jobId)` | anyone |

In v1 Defigent is always the client and the evaluator. Inbound offers from either side go to review; the verdict comes
back as a typed `accept` or `decline`. A job that names Defigent as evaluator but was not created by Defigent gets a
`status` only (`ours: false`): Defigent does not evaluate it. The responder also sweeps its open jobs periodically, so a
`submit` nobody announced and an expiring job are still picked up, and a pending evaluation is raised again as `urgent`
in the last 6 hours before its deadline.

## 5. A2A task state

The ERC-8183 state travels in the payload; the A2A task state is a coarse mapping. Replies are a Task whose
`status.message` carries the typed `status` or `error` DataPart plus one TextPart. The task id equals the `contextId`
the peer used.

| Situation | Task state |
|---|---|
| The responder's turn: offer under review, create the job, fund, evaluate | `working` |
| The counterparty's turn: answer our offer, set the budget, submit | `input-required` |
| The job is Completed on chain, or the counterparty declined our offer | `completed` |
| We declined the offer, or a business rule rejected the message | `rejected` |
| The evaluator rejected the deliverable, the job expired, or the offer expired | `failed` |

In A2A 1.0 these are `TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_COMPLETED`, `TASK_STATE_REJECTED`
and `TASK_STATE_FAILED`. A `status` or `error` sent to the inbox keeps the task's state, which can also be `canceled`
(`TASK_STATE_CANCELED`).

## 6. Errors

**Schema errors** (bad field, unknown format, more than one typed key): JSON-RPC `-32602 Invalid params`. No task is
created. `error.data` carries a `google.rpc.BadRequest` with the field violation and a `google.rpc.ErrorInfo` with
`reason: "INVALID_TYPED_MESSAGE"`, `domain` = the extension URI and `metadata.field` = the field.

**Chain unavailable** (an on-chain read failed or timed out): JSON-RPC `-32603`, `ErrorInfo` with
`reason: "CHAIN_UNAVAILABLE"` and `metadata.retryable: "true"`. Nothing is persisted; retry the same message.

**Business rules**: a Task in state `rejected` whose message carries `defigent.job.error`.

| Code | When | Retryable |
|---|---|---|
| `unknown_offer` | the offer does not exist, or it is not one you can accept or decline | no |
| `offer_expired` | the offer expired, or less than one hour is left to work on it | no |
| `offer_taken` | another party already accepted the offer | no |
| `identity_mismatch` | `party.address` is neither owner nor agent wallet of `party.agentId`, or the agentId is not the offer's `to` | no |
| `job_not_found` | no such job on the escrow | no |
| `state_mismatch` | the message does not fit the offer's state, e.g. declining an accepted offer | no |
| `idempotency_conflict` | the same `offerId` arrived before with different content | no |
| `unsupported_key` | a `defigent.job.*` key that v1 does not define | no |
| `unsupported_terms` | another escrow, a token that is not allowed, `decimals` or `symbol` that are not the token's, or an amount over the cap | no |
| `capacity_exceeded` | a quantity cap was reached (open offers per agent, jobs per day) | yes |

## 7. Idempotency

Two levels, both persistent:

- **Per message.** The pair (sender, `messageId`) is stored. Resending the same message returns the same reply and
  triggers no new action. A retryable error is not stored, so its retry is recomputed.
- **Per natural key.** Handlers key on `offerId` or `jobId`, not on `contextId`. The same key with the same content
  returns the same reply; the same `offerId` with different content returns `idempotency_conflict`.

The reply is posted to the `contextId` the peer used, and an accepted offer keeps that `contextId`, so later updates land
where the peer polls (`tasks/get`, or another `query`).

## 8. On-chain `description`

When the job is created, `createJob` stores in `description` a canonical JSON (keys sorted, no whitespace) with its own
version:

```json
{"offerId":"of_7Hq2kd9xTa","terms":"0x<keccak256 of the canonical offer JSON>","v":1}
```

`terms` is the keccak256 of the offer's canonical JSON (same canonicalization), computed on the offer **as the responder
validated it**, not on the bytes that were sent:

- addresses (`price.token`, `settlement.escrow`, `from.address`) in their EIP-55 checksum form;
- hashes (`deliverable.expectedHash`) in lowercase;
- fields this extension does not define removed, at every level;
- optional fields that were absent stay absent (no defaults are added).

An issuer that sent its offer in another form normalizes it the same way before hashing. Anyone can then check that a
job matches the offer before spending gas on it. The job's `client` is the address that created it.

## 9. Compatibility with `offer_schema_v1`

A DataPart `{ intent: "offer", service, price, asset?, expiry?, terms? }` is still accepted and normalized to a
`defigent.job.offer` with `side: "provider"`: `price` (decimal) becomes base units of `asset` (USDC by default), `expiry`
(milliseconds) becomes `expiresAt` (seconds; 24 h from now when absent), and `terms` becomes `description`. The reply is
typed, and the normalized offer follows the rules of a `defigent.job.offer`: an expired one gets `offer_expired`, and one
over the amount cap gets `unsupported_terms`.

## 10. Security

- The inbox signs no transactions and holds no keys. Money-moving steps are queued for the operator.
- The inbox never requests URLs that arrive in messages (`replyTo.url`, `deliverable.uri`).
- Task history is public. Typed messages carry no secrets.
- Offers are not signed in v1. Authenticity comes from the chain: the job is created by Defigent's address, and the
  provider can verify `client` and `description` before spending gas.

## 11. Versioning

Within v1, changes are additive only: new optional fields, new error codes, new keys. An incompatible change gets a new
URI (`…/erc8183-jobs/v2`), and there is no fallback between major versions. Ignore fields you do not know.
