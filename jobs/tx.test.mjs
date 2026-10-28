import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, getAddress, keccak256, toBytes, zeroAddress } from "viem";
import { ERC20_ABI, ESCROW_ABI } from "./abi.mjs";
import { loadJobsConfig } from "./config.mjs";
import { actionFor } from "./handlers.mjs";
import { jobDescription, parseTyped, termsHash } from "./protocol.mjs";
import { buildActionTxs, createdJobId, outboxLineFor } from "./tx.mjs";

const cfg = loadJobsConfig({ env: {} });
const USDC = cfg.tokens.USDC.address;
const A = getAddress("0xabc0000000000000000000000000000000000001");
const OFFER_ID = "of_AbCdEf1234";
const INBOUND_ID = "of_InBound123";
const EXPIRES = 1792086400;
const TX = `0x${"ab".repeat(32)}`;

function parsed(name, body) {
  const r = parseTyped(name, body);
  assert.equal(r.ok, true, `${name}: ${r.field} ${r.detail}`);
  return r.value;
}

const terms = parsed("offer", {
  offerId: OFFER_ID, side: "client", service: "a2a-conformance-probe", description: "Answer tasks/get and return the raw response.",
  price: { amount: "250000", token: USDC, decimals: 6, symbol: "USDC" }, settlement: { chainId: 143, escrow: cfg.escrow },
  deliverable: { mediaType: "application/json", acceptance: "operator" }, gas: { providerTxs: 2, grant: "50000000000000000" },
  from: { address: cfg.client, agentId: 10331 }, to: { agentId: 10270 }, expiresAt: EXPIRES,
});
const accepted = {
  offerId: OFFER_ID, direction: "out", contextId: OFFER_ID, terms, termsHash: termsHash(terms), state: "accepted", expiresAt: EXPIRES,
  acceptedAddress: A, acceptedAgentId: 10270,
};
const job = { jobId: 42n, paymentToken: USDC, budget: 250000n };
// Action rows as the store returns them: built by the handlers' actionFor, plus the contextId the runtime stores.
const row = (a, contextId = OFFER_ID) => ({ ...a, contextId, state: "pending" });
const createAction = row(actionFor({ kind: "create_job", next: { ours: true, action: "create_job" }, offer: accepted, config: cfg }));
const grantAction = row(actionFor({ kind: "gas_grant", next: { ours: true, action: "create_job" }, offer: accepted, config: cfg }));
const fundAction = row(actionFor({ kind: "fund", next: { ours: true, action: "fund" }, job, config: cfg }));
const evaluateAction = row(actionFor({ kind: "evaluate", next: { ours: true, action: "evaluate", deadline: EXPIRES + 3600, urgent: false }, job, config: cfg }));
const refundAction = row(actionFor({ kind: "refund", next: { ours: true, action: "refund" }, job, config: cfg }));
const reviewOffer = row({ key: `review_offer:${INBOUND_ID}`, action: "review_offer", payload: { offerId: INBOUND_ID, side: "provider", service: "hash-text", price: terms.price, from: { address: A, agentId: 10270 } } }, "ctx-offer");
const reviewClaim = row(actionFor({ kind: "review_claim", claimId: 7, claim: { name: "funded", body: { jobId: "42" }, reason: "job 42 is Open on chain" } }), "ctx-1");

const decode = (abi, tx) => decodeFunctionData({ abi, data: tx.data });

test("create_job encodes createJob with the canonical description and the configured hook", () => {
  const txs = buildActionTxs(createAction, cfg);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].label, "createJob");
  assert.equal(txs[0].to, cfg.escrow);
  assert.equal(txs[0].value, undefined);
  const { functionName, args } = decode(ESCROW_ABI, txs[0]);
  assert.equal(functionName, "createJob");
  assert.deepEqual(args, [A, cfg.evaluator, EXPIRES, jobDescription(terms), cfg.hook, 10270n]);
});

test("fund approves the exact amount before funding", () => {
  const txs = buildActionTxs(fundAction, cfg);
  assert.deepEqual(txs.map((t) => t.label), ["approve", "fund"]);
  assert.equal(txs[0].to, USDC);
  assert.deepEqual(decode(ERC20_ABI, txs[0]), { functionName: "approve", args: [cfg.escrow, 250000n] });
  assert.equal(txs[1].to, cfg.escrow);
  assert.deepEqual(decode(ESCROW_ABI, txs[1]), { functionName: "fund", args: [42n, USDC, 250000n, "0x"] });
});

test("evaluate complete has a 700000 gas floor and needs a verdict", () => {
  assert.throws(() => buildActionTxs(evaluateAction, cfg), /verdict required/);
  assert.throws(() => buildActionTxs(evaluateAction, cfg, { verdict: "accept" }), /complete or reject/);

  const [complete] = buildActionTxs(evaluateAction, cfg, { verdict: "complete" });
  assert.equal(complete.label, "complete");
  assert.equal(complete.to, cfg.escrow);
  assert.equal(complete.gasFloor, 700000n);
  assert.deepEqual(decode(ESCROW_ABI, complete), { functionName: "complete", args: [42n, keccak256(toBytes("accepted")), "0x"] });

  const [withReason] = buildActionTxs(evaluateAction, cfg, { verdict: "complete", reason: "hash matches" });
  assert.deepEqual(decode(ESCROW_ABI, withReason).args, [42n, keccak256(toBytes("hash matches")), "0x"]);

  const [reject] = buildActionTxs(evaluateAction, cfg, { verdict: "reject" });
  assert.equal(reject.label, "reject");
  assert.equal(reject.gasFloor, undefined);
  assert.deepEqual(decode(ESCROW_ABI, reject), { functionName: "reject", args: [42n, keccak256(toBytes("rejected")), "0x"] });
});

test("refund calls claimRefund(jobId)", () => {
  const txs = buildActionTxs(refundAction, cfg);
  assert.deepEqual(txs.map((t) => [t.label, t.to]), [["claimRefund", cfg.escrow]]);
  assert.deepEqual(decode(ESCROW_ABI, txs[0]), { functionName: "claimRefund", args: [42n] });
});

test("gas_grant is a plain value transfer and the review actions have no transactions", () => {
  assert.deepEqual(buildActionTxs(grantAction, cfg), [{ label: "transfer", to: A, value: 50000000000000000n, data: "0x" }]);
  assert.deepEqual(buildActionTxs(reviewOffer, cfg, { verdict: "accept" }), []);
  assert.deepEqual(buildActionTxs(reviewClaim, cfg), []);
  assert.throws(() => buildActionTxs({ ...refundAction, action: "launch" }, cfg), /unknown action launch/);
});

test("outbox lines carry the action key as replyId and the typed result", () => {
  const lines = [
    [outboxLineFor(createAction, { txHash: TX, jobId: "42" }), "input-required", { "defigent.job.created": { offerId: OFFER_ID, jobId: "42", txHash: TX } }],
    [outboxLineFor(fundAction, { txHash: TX }), "input-required", { "defigent.job.funded": { jobId: "42", txHash: TX } }],
    [outboxLineFor(evaluateAction, { txHash: TX, verdict: "complete" }), "completed", { "defigent.job.completed": { jobId: "42", txHash: TX } }],
    [outboxLineFor(evaluateAction, { txHash: TX, verdict: "reject" }), "failed", { "defigent.job.rejected": { jobId: "42", txHash: TX } }],
    [outboxLineFor(refundAction, { txHash: TX }), "failed", { "defigent.job.expired": { jobId: "42", txHash: TX } }],
    [outboxLineFor(reviewOffer, { verdict: "accept", party: { address: A, agentId: 10270 } }), "working", { "defigent.job.accept": { offerId: INBOUND_ID, party: { address: A, agentId: 10270 } } }],
    // R15: declining an inbound offer leaves the task rejected.
    [outboxLineFor(reviewOffer, { verdict: "decline" }), "rejected", { "defigent.job.decline": { offerId: INBOUND_ID, reason: "other" } }],
  ];
  for (const [line, state, data] of lines) {
    const [name, body] = Object.entries(data)[0];
    assert.equal(line.state, state, name);
    assert.deepEqual(line.data, data);
    assert.equal(typeof line.text, "string");
    assert.ok(line.text.length > 0 && line.text.length <= 4000, name);
    // Every claim must pass the schema the outbox applies (parseClaim) and the sweep then verifies.
    assert.equal(parseTyped(name.slice("defigent.job.".length), body).ok, true, name);
  }
  assert.deepEqual(lines.map(([l]) => [l.contextId, l.replyId]), [
    [OFFER_ID, `create_job:${OFFER_ID}`], [OFFER_ID, "fund:42"], [OFFER_ID, "evaluate:42"], [OFFER_ID, "evaluate:42"], [OFFER_ID, "refund:42"],
    ["ctx-offer", `review_offer:${INBOUND_ID}`], ["ctx-offer", `review_offer:${INBOUND_ID}`],
  ]);

  // R14: gas_grant has no typed data (the outbox rejects data: null, so the key is absent); review_claim has no line at all.
  const grant = outboxLineFor(grantAction, { txHash: TX });
  assert.deepEqual(Object.keys(grant).sort(), ["contextId", "replyId", "state", "text"]);
  assert.deepEqual([grant.contextId, grant.replyId, grant.state], [OFFER_ID, `gas_grant:${OFFER_ID}`, "input-required"]);
  assert.equal(outboxLineFor(reviewClaim, {}), null);

  assert.throws(() => outboxLineFor(evaluateAction, { txHash: TX }), /verdict required/);
  assert.throws(() => outboxLineFor(reviewOffer, {}), /verdict required/);
  assert.throws(() => outboxLineFor(reviewOffer, { verdict: "accept" }), /party required/);
  assert.throws(() => outboxLineFor(createAction, { txHash: TX }), /jobId required/);
});

test("createdJobId reads jobId from the escrow's JobCreated log (topics[1]) and ignores other contracts", () => {
  const topics = encodeEventTopics({ abi: ESCROW_ABI, eventName: "JobCreated", args: { jobId: 43n, client: cfg.client, provider: A } });
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint48" }, { type: "address" }], [cfg.evaluator, EXPIRES, cfg.hook]);
  const log = { address: cfg.escrow.toLowerCase(), topics, data };
  assert.equal(createdJobId([{ address: USDC, topics: [topics[0], `0x${"0".repeat(63)}9`], data: "0x" }, log], cfg.escrow), "43");
  assert.equal(createdJobId([{ ...log, address: zeroAddress }], cfg.escrow), null);
});
