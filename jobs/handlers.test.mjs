import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, zeroAddress } from "viem";
import { loadJobsConfig } from "./config.mjs";
import { jobDescription, parseTyped, termsHash } from "./protocol.mjs";
import { nextStep } from "./next.mjs";
import { actionFor, handleAccept, handleDecline, handleJobMessage, handleOffer, statusBody } from "./handlers.mjs";

const cfg = loadJobsConfig({ env: {} });
const USDC = cfg.tokens.USDC.address;
const A = getAddress("0xabc0000000000000000000000000000000000001");
const OTHER = getAddress("0x0000000000000000000000000000000000000bad");
const T = 1792000000;
const EXPIRES = T + 86400;
const HASH = `0x${"ab".repeat(32)}`;
const HASH2 = `0x${"cd".repeat(32)}`;

function parsed(name, body) {
  const r = parseTyped(name, body);
  assert.equal(r.ok, true, `${name}: ${r.field} ${r.detail}`);
  return r.value;
}

const price = { amount: "250000", token: USDC, decimals: 6, symbol: "USDC" };
const outTerms = parsed("offer", {
  offerId: "of_AbCdEf1234", side: "client", service: "a2a-conformance-probe", description: "Answer tasks/get and return the raw response.",
  price, settlement: { chainId: 143, escrow: cfg.escrow }, deliverable: { mediaType: "application/json", acceptance: "operator" },
  gas: { providerTxs: 2, grant: null }, from: { address: cfg.client, agentId: 10331 }, to: { agentId: 10270 },
  replyTo: { url: "https://defigent.example/inbox", contextId: "of_AbCdEf1234" }, expiresAt: EXPIRES,
});
const outRow = (overrides = {}) => ({
  offerId: outTerms.offerId, direction: "out", peerAgentId: 10270, peerAddress: null, peerEndpoint: "https://peer.example/a2a",
  contextId: outTerms.offerId, terms: outTerms, termsHash: termsHash(outTerms), state: "open", expiresAt: EXPIRES,
  acceptedAddress: null, acceptedAgentId: null, jobId: null, chainStatus: null, deliverable: null, ...overrides,
});
const outOffer = outRow();

const inboundOffer = parsed("offer", {
  offerId: "of_InBound123", side: "provider", service: "hash-text", description: "keccak256 of a text",
  price, settlement: { chainId: 143, escrow: cfg.escrow }, deliverable: { mediaType: "text/plain", acceptance: "operator" },
  from: { address: A, agentId: 10270 }, replyTo: { url: "https://peer.example/reply", contextId: "ctx-1" }, expiresAt: EXPIRES,
});
const offerArgs = (overrides = {}) => ({
  msg: inboundOffer, now: T, config: cfg, counts: { openOffersForAgent: 0 }, tokenAllowed: true, existingOffer: null, ...overrides,
});

const accept = parsed("accept", { offerId: outTerms.offerId, party: { address: A, agentId: 10270 } });
const acceptArgs = (overrides = {}) => ({ msg: accept, offer: outOffer, bound: true, now: T, config: cfg, counts: { createJobsToday: 0 }, ...overrides });

const job = (overrides = {}) => ({
  jobId: 42n, client: cfg.client, status: "Open", provider: A, expiredAt: EXPIRES, evaluator: cfg.evaluator, submittedAt: 0,
  budget: 0n, hook: cfg.hook, paymentToken: zeroAddress, providerAgentId: 10270n, description: jobDescription(outTerms),
  settledAmount: 0n, payoutReceiver: zeroAddress, ...overrides,
});
const linked = outRow({ state: "accepted", acceptedAddress: A, acceptedAgentId: 10270, jobId: "42", chainStatus: "Open" });
const jobArgs = (overrides = {}) => ({
  name: "query", msg: parsed("query", { jobId: "42" }), offer: linked, job: job(), now: T, config: cfg, pendingClaim: false, deliverable: null, ...overrides,
});

function assertError(o, code, field, retryable = false) {
  assert.equal(o.reply.name, "error");
  assert.equal(o.reply.body.code, code);
  assert.equal(o.reply.body.field, field);
  assert.equal(o.reply.body.retryable, retryable);
  assert.equal(typeof o.reply.body.message, "string");
  assert.equal(o.text, o.reply.body.message);
  assert.equal(o.taskState, "rejected");
  assert.deepEqual(o.actions, []);
  assert.deepEqual(o.ops, []);
}

test("an inbound offer goes to review", () => {
  const o = handleOffer(offerArgs());
  assert.equal(o.reply.name, "status");
  assert.deepEqual(o.reply.body.offer, { offerId: inboundOffer.offerId, state: "under_review" });
  assert.equal(o.reply.body.job, undefined);
  assert.equal(o.reply.body.next.ours, true);
  assert.equal(o.taskState, "working");
  assert.equal(o.text, o.reply.body.next.note);
  assert.deepEqual(o.actions.map((a) => a.key), [`review_offer:${inboundOffer.offerId}`]);
  assert.deepEqual(o.actions[0], {
    key: `review_offer:${inboundOffer.offerId}`, action: "review_offer",
    payload: {
      offerId: inboundOffer.offerId, side: "provider", service: "hash-text", description: "keccak256 of a text", price,
      deliverable: { mediaType: "text/plain", acceptance: "operator" }, gas: null, from: { address: A, agentId: 10270 }, to: null, expiresAt: EXPIRES,
    },
  });
  // The peer endpoint is never taken from replyTo.url (R9).
  assert.deepEqual(o.ops, [{
    op: "insertOffer",
    row: {
      offerId: inboundOffer.offerId, direction: "in", peerAgentId: 10270, peerAddress: A, peerEndpoint: null, terms: inboundOffer,
      termsHash: termsHash(inboundOffer), state: "under_review", expiresAt: EXPIRES, createdAt: T,
    },
  }]);

  const anon = { ...inboundOffer };
  delete anon.from;
  const o2 = handleOffer(offerArgs({ msg: anon }));
  assert.equal(o2.actions[0].payload.from, null);
  assert.equal(o2.ops[0].row.peerAgentId, null);
  assert.equal(o2.ops[0].row.peerAddress, null);
});

test("a foreign escrow, a disallowed token or an amount over the cap gets unsupported_terms", () => {
  const foreign = { ...inboundOffer, settlement: { chainId: 143, escrow: OTHER } };
  assertError(handleOffer(offerArgs({ msg: foreign })), "unsupported_terms", "settlement.escrow");
  assertError(handleOffer(offerArgs({ tokenAllowed: false })), "unsupported_terms", "price.token");
  // Allowed on chain but not a token Defigent is configured for.
  const unknownToken = { ...inboundOffer, price: { ...price, token: OTHER } };
  assertError(handleOffer(offerArgs({ msg: unknownToken })), "unsupported_terms", "price.token");
  const tooMuch = { ...inboundOffer, price: { ...price, amount: "1000001" } };
  assertError(handleOffer(offerArgs({ msg: tooMuch })), "unsupported_terms", "price.amount");
  const atCap = { ...inboundOffer, price: { ...price, amount: "1000000" } };
  assert.equal(handleOffer(offerArgs({ msg: atCap })).reply.name, "status");
});

test("an expired offer gets offer_expired; too many open offers gets capacity_exceeded", () => {
  assertError(handleOffer(offerArgs({ now: EXPIRES })), "offer_expired", "expiresAt");
  assertError(handleOffer(offerArgs({ now: EXPIRES + 1 })), "offer_expired", "expiresAt");
  assert.equal(handleOffer(offerArgs({ now: EXPIRES - 1 })).reply.name, "status");
  assertError(handleOffer(offerArgs({ counts: { openOffersForAgent: 2 } })), "capacity_exceeded", "from.agentId", true);
  assert.equal(handleOffer(offerArgs({ counts: { openOffersForAgent: 1 } })).reply.name, "status");
});

test("an offerId already on record replays with the same terms and conflicts with different ones", () => {
  const existing = { ...handleOffer(offerArgs()).ops[0].row, contextId: "ctx-1", acceptedAddress: null, acceptedAgentId: null, jobId: null };
  const replay = handleOffer(offerArgs({ existingOffer: existing }));
  assert.deepEqual(replay.reply.body.offer, { offerId: inboundOffer.offerId, state: "under_review" });
  assert.equal(replay.taskState, "working");
  assert.deepEqual(replay.ops, []);
  assert.deepEqual(replay.actions, []);

  const changed = { ...inboundOffer, price: { ...price, amount: "300000" } };
  assertError(handleOffer(offerArgs({ msg: changed, existingOffer: existing })), "idempotency_conflict", "offerId");
  // Reusing the offerId of one of our outbound offers with other terms conflicts too.
  assertError(handleOffer(offerArgs({ msg: { ...inboundOffer, offerId: outTerms.offerId }, existingOffer: outOffer })), "idempotency_conflict", "offerId");
});

test("accepting our open offer by the bound agent enqueues create_job with the canonical description", () => {
  const o = handleAccept(acceptArgs());
  assert.equal(o.reply.name, "status");
  assert.deepEqual(o.reply.body.offer, { offerId: outOffer.offerId, state: "accepted" });
  assert.equal(o.reply.body.next.action, "create_job");
  assert.equal(o.taskState, "working");
  assert.equal(o.text, o.reply.body.next.note);
  const a = o.actions.find((x) => x.action === "create_job");
  assert.equal(a.key, `create_job:${outOffer.offerId}`);
  assert.equal(a.payload.description, jobDescription(outOffer.terms));
  assert.equal(a.payload.expiredAt, outOffer.expiresAt);
  assert.deepEqual(a.payload, {
    offerId: outOffer.offerId, provider: A, agentId: 10270, evaluator: cfg.evaluator, hook: cfg.hook, expiredAt: EXPIRES,
    description: jobDescription(outTerms), token: USDC, amount: "250000",
  });
  assert.deepEqual(o.actions.map((x) => x.action), ["create_job"]);
  assert.deepEqual(o.ops, [{ op: "accept", offerId: outOffer.offerId, address: A, agentId: 10270 }]);
  // Exactly the minimum work window left is still enough; the cap allows the last job of the day.
  assert.equal(handleAccept(acceptArgs({ now: EXPIRES - 3600 })).reply.name, "status");
  assert.equal(handleAccept(acceptArgs({ counts: { createJobsToday: 9 } })).reply.name, "status");
});

test("accept errors map to their codes and leave the task rejected", () => {
  assertError(handleAccept(acceptArgs({ offer: null })), "unknown_offer", "offerId");
  // An inbound offer is not ours to have accepted (R21).
  assertError(handleAccept(acceptArgs({ offer: outRow({ direction: "in", terms: { ...outTerms, side: "provider" } }) })), "unknown_offer", "offerId");
  assertError(handleAccept(acceptArgs({ now: EXPIRES })), "offer_expired", "offerId");
  assertError(handleAccept(acceptArgs({ now: EXPIRES - 3599 })), "offer_expired", "offerId");
  assertError(handleAccept(acceptArgs({ offer: outRow({ state: "expired" }) })), "offer_expired", "offerId");
  assertError(handleAccept(acceptArgs({ offer: outRow({ state: "accepted", acceptedAddress: OTHER, acceptedAgentId: 7 }) })), "offer_taken", "offerId");
  assertError(handleAccept(acceptArgs({ offer: outRow({ state: "declined" }) })), "state_mismatch", "offerId");
  const wrongAgent = parsed("accept", { offerId: outTerms.offerId, party: { address: A, agentId: 999 } });
  assertError(handleAccept(acceptArgs({ msg: wrongAgent })), "identity_mismatch", "party.agentId");
  assertError(handleAccept(acceptArgs({ bound: false })), "identity_mismatch", "party.address");
  assertError(handleAccept(acceptArgs({ counts: { createJobsToday: 10 } })), "capacity_exceeded", undefined, true);
});

test("the same party accepting again gets the accepted status without new ops or actions", () => {
  const o = handleAccept(acceptArgs({ offer: outRow({ state: "accepted", acceptedAddress: A, acceptedAgentId: 10270 }) }));
  assert.equal(o.reply.name, "status");
  assert.deepEqual(o.reply.body.offer, { offerId: outOffer.offerId, state: "accepted" });
  assert.equal(o.taskState, "working");
  assert.deepEqual(o.ops, []);
  assert.deepEqual(o.actions, []);
});

test("an offer with gas.grant also enqueues gas_grant", () => {
  const terms = { ...outTerms, gas: { providerTxs: 2, grant: "50000000000000000" } };
  const o = handleAccept(acceptArgs({ offer: outRow({ terms, termsHash: termsHash(terms) }) }));
  assert.deepEqual(o.actions.map((a) => a.key), [`create_job:${outTerms.offerId}`, `gas_grant:${outTerms.offerId}`]);
  assert.deepEqual(o.actions[1], { key: `gas_grant:${outTerms.offerId}`, action: "gas_grant", payload: { to: A, amountWei: "50000000000000000" } });
  assert.equal(o.actions[0].payload.description, jobDescription(terms));
  // Without a grant, or with grant null, there is no gas_grant.
  assert.equal(handleAccept(acceptArgs()).actions.some((a) => a.action === "gas_grant"), false);
});

test("accepting an offer where we are the provider records it but enqueues nothing", () => {
  const terms = { ...outTerms, side: "provider", gas: { providerTxs: 2, grant: "1" } };
  const o = handleAccept(acceptArgs({ offer: outRow({ terms, termsHash: termsHash(terms) }), counts: { createJobsToday: 10 } }));
  assert.deepEqual(o.reply.body.offer, { offerId: outOffer.offerId, state: "accepted" });
  assert.equal(o.reply.body.next.ours, false);
  assert.equal(o.taskState, "input-required");
  assert.deepEqual(o.actions, []);
  assert.deepEqual(o.ops, [{ op: "accept", offerId: outOffer.offerId, address: A, agentId: 10270 }]);
});

test("a decline of our offer completes the task", () => {
  const decline = parsed("decline", { offerId: outTerms.offerId, reason: "price" });
  const o = handleDecline({ msg: decline, offer: outOffer, now: T });
  assert.equal(o.reply.name, "status");
  assert.deepEqual(o.reply.body.offer, { offerId: outOffer.offerId, state: "declined" });
  assert.equal(o.reply.body.next.actor, null);
  assert.equal(o.taskState, "completed");
  assert.deepEqual(o.ops, [{ op: "setOfferState", offerId: outOffer.offerId, state: "declined" }]);
  assert.deepEqual(o.actions, []);
  // A repeated decline replays the declined status.
  const again = handleDecline({ msg: decline, offer: outRow({ state: "declined" }), now: T });
  assert.equal(again.taskState, "completed");
  assert.deepEqual(again.ops, []);
});

test("a decline after the offer was accepted gets state_mismatch", () => {
  const decline = parsed("decline", { offerId: outTerms.offerId, reason: "other" });
  assertError(handleDecline({ msg: decline, offer: outRow({ state: "accepted", acceptedAddress: A, acceptedAgentId: 10270 }), now: T }), "state_mismatch", "offerId");
  assertError(handleDecline({ msg: decline, offer: null, now: T }), "unknown_offer", "offerId");
  assertError(handleDecline({ msg: decline, offer: outRow({ direction: "in" }), now: T }), "unknown_offer", "offerId");
  assertError(handleDecline({ msg: decline, offer: outRow({ state: "expired" }), now: T }), "offer_expired", "offerId");
});

test("a query by jobId returns chain state and next: ours → working, theirs → input-required", () => {
  const theirs = handleJobMessage(jobArgs());
  assert.equal(theirs.reply.name, "status");
  assert.deepEqual(theirs.reply.body, {
    offer: { offerId: outTerms.offerId, state: "accepted" },
    job: {
      jobId: "42", chainStatus: "Open", client: cfg.client, provider: A, evaluator: cfg.evaluator, budget: { amount: "0", token: null },
      expiresAt: EXPIRES, submittedAt: null, deliverable: null,
    },
    next: nextStep({ job: job(), offer: linked, now: T, config: cfg }),
  });
  assert.equal(theirs.reply.body.next.function, "setBudget(uint256,address,uint256,bytes)");
  assert.equal(theirs.taskState, "input-required");
  assert.equal(theirs.text, theirs.reply.body.next.note);
  assert.deepEqual(theirs.actions, []);
  assert.deepEqual(theirs.ops, []);

  const fundable = job({ budget: 250000n, paymentToken: USDC });
  const ours = handleJobMessage(jobArgs({ job: fundable, name: "budget_set", msg: parsed("budget_set", { jobId: "42" }) }));
  assert.deepEqual(ours.reply.body.job.budget, { amount: "250000", token: USDC });
  assert.equal(ours.reply.body.next.action, "fund");
  assert.equal(ours.taskState, "working");
  assert.deepEqual(ours.actions, [{ key: "fund:42", action: "fund", payload: { jobId: "42", token: USDC, amount: "250000" } }]);

  // The ledger learns the new chain status.
  const funded = handleJobMessage(jobArgs({ job: job({ status: "Funded", budget: 250000n, paymentToken: USDC }) }));
  assert.deepEqual(funded.ops, [{ op: "setChainStatus", offerId: outTerms.offerId, status: "Funded" }]);
  assert.equal(funded.taskState, "input-required");

  // A job of our escrow with no offer on record still gets a status, with no ops.
  const bare = handleJobMessage(jobArgs({ offer: null }));
  assert.equal(bare.reply.body.offer, undefined);
  assert.equal(bare.reply.body.job.jobId, "42");
  assert.deepEqual(bare.ops, []);

  // An expired Funded job we pay for gets a refund.
  const late = handleJobMessage(jobArgs({ job: job({ status: "Funded", budget: 250000n, paymentToken: USDC }), now: EXPIRES }));
  assert.deepEqual(late.actions, [{ key: "refund:42", action: "refund", payload: { jobId: "42" } }]);
  assert.equal(late.taskState, "working");
});

test("a query by offerId without a job returns the offer step", () => {
  const o = handleJobMessage(jobArgs({ msg: parsed("query", { offerId: outTerms.offerId }), offer: outOffer, job: null }));
  assert.deepEqual(o.reply.body.offer, { offerId: outTerms.offerId, state: "open" });
  assert.equal(o.reply.body.job, undefined);
  assert.equal(o.reply.body.next.actor, "provider");
  assert.equal(o.taskState, "input-required");
  assert.deepEqual(o.actions, []);
  // An accepted offer awaiting create_job does not enqueue it again from a query.
  const accepted = handleJobMessage(jobArgs({ msg: parsed("query", { offerId: outTerms.offerId }), offer: outRow({ state: "accepted", acceptedAddress: A, acceptedAgentId: 10270 }), job: null }));
  assert.equal(accepted.reply.body.next.action, "create_job");
  assert.equal(accepted.taskState, "working");
  assert.deepEqual(accepted.actions, []);
});

test("a submitted notice stores the deliverable reference and enqueues evaluate", () => {
  const submitted = job({ status: "Submitted", budget: 250000n, paymentToken: USDC, submittedAt: T });
  const notice = parsed("submitted", { jobId: "42", deliverable: { hash: HASH, uri: "https://peer.example/out.json", mediaType: "application/json" } });
  const o = handleJobMessage(jobArgs({ name: "submitted", msg: notice, job: submitted, deliverable: HASH }));
  assert.deepEqual(o.ops, [
    { op: "setChainStatus", offerId: outTerms.offerId, status: "Submitted" },
    { op: "setDeliverable", offerId: outTerms.offerId, deliverable: notice.deliverable },
  ]);
  const ref = { hash: HASH, uri: "https://peer.example/out.json", mediaType: "application/json", verified: true };
  assert.deepEqual(o.actions, [{
    key: "evaluate:42", action: "evaluate",
    payload: { jobId: "42", offerId: outTerms.offerId, client: cfg.client, deadline: EXPIRES + 3600, urgent: false, deliverable: ref },
  }]);
  assert.deepEqual(o.reply.body.job.deliverable, ref);
  assert.equal(o.reply.body.job.submittedAt, T);
  assert.equal(o.taskState, "working");

  // The chain hash is not readable: the notice is carried as unverified.
  const unread = handleJobMessage(jobArgs({ name: "submitted", msg: notice, job: submitted, deliverable: null }));
  assert.deepEqual(unread.actions[0].payload.deliverable, { ...notice.deliverable, verified: false });

  // The chain contradicts the notice: the chain hash wins and the notice is not stored.
  const wrong = handleJobMessage(jobArgs({ name: "submitted", msg: notice, job: submitted, deliverable: HASH2 }));
  assert.deepEqual(wrong.actions[0].payload.deliverable, { hash: HASH2, verified: true });
  assert.equal(wrong.ops.some((x) => x.op === "setDeliverable"), false);

  // A query later falls back to the stored reference.
  const stored = outRow({ ...linked, chainStatus: "Submitted", deliverable: notice.deliverable });
  const later = handleJobMessage(jobArgs({ offer: stored, job: submitted, deliverable: null }));
  assert.deepEqual(later.actions[0].payload.deliverable, { ...notice.deliverable, verified: false });
  assert.deepEqual(later.ops, []);
});

test("a query for a missing job gets job_not_found", () => {
  assertError(handleJobMessage(jobArgs({ job: null, offer: null })), "job_not_found", "jobId");
  assertError(handleJobMessage(jobArgs({ name: "funded", msg: parsed("funded", { jobId: "42" }), job: null, offer: null })), "job_not_found", "jobId");
  assertError(handleJobMessage(jobArgs({ msg: parsed("query", { offerId: "of_Missing123" }), job: null, offer: null })), "unknown_offer", "offerId");
});

test("evaluate is never enqueued when we are not the evaluator", () => {
  const submitted = job({ status: "Submitted", budget: 250000n, paymentToken: USDC, submittedAt: T, evaluator: OTHER });
  const o = handleJobMessage(jobArgs({ job: submitted, deliverable: HASH }));
  assert.equal(o.reply.body.next.action, "evaluate");
  assert.equal(o.reply.body.next.ours, false);
  assert.deepEqual(o.actions, []);
  assert.equal(o.taskState, "input-required");
  // actionFor refuses it as well, whatever the caller asks.
  const next = nextStep({ job: submitted, offer: linked, now: T, config: cfg });
  assert.equal(actionFor({ kind: "evaluate", next, job: submitted, offer: linked, deliverable: HASH, config: cfg }), null);
});

test("actionFor builds the remaining payloads and refuses actions that are not ours", () => {
  const fundable = job({ budget: 250000n, paymentToken: USDC });
  const theirs = job({ client: OTHER, budget: 250000n, paymentToken: USDC });
  assert.equal(actionFor({ kind: "fund", next: nextStep({ job: theirs, offer: linked, now: T, config: cfg }), job: theirs, offer: linked, config: cfg }), null);
  // A kind that does not match next.action is refused.
  assert.equal(actionFor({ kind: "refund", next: nextStep({ job: fundable, offer: linked, now: T, config: cfg }), job: fundable, offer: linked, config: cfg }), null);
  assert.deepEqual(actionFor({ kind: "review_claim", claimId: 7, claim: { name: "created", body: { jobId: "42" }, reason: "provider mismatch" }, config: cfg }), {
    key: "review_claim:7", action: "review_claim", payload: { claimId: 7, name: "created", body: { jobId: "42" }, reason: "provider mismatch" },
  });
  assert.equal(actionFor({ kind: "teleport", config: cfg }), null);
});

test("statusBody has only the parts it is given", () => {
  const next = { actor: null, ours: false, note: "x" };
  assert.deepEqual(statusBody({ next }), { next });
  assert.deepEqual(statusBody({ offer: outOffer, next }), { offer: { offerId: outTerms.offerId, state: "open" }, next });
  const body = statusBody({ job: job({ budget: 5n, paymentToken: USDC, submittedAt: T }), next });
  assert.deepEqual(body.job.budget, { amount: "5", token: USDC });
  assert.equal(body.job.submittedAt, T);
  assert.equal(body.job.deliverable, null);
  assert.doesNotThrow(() => JSON.stringify(body));
});

test("an inbound offer's gas.grant is shown to the operator but never queued as gas_grant", () => {
  const withGrant = parsed("offer", { ...inboundOffer, gas: { providerTxs: 2, grant: "1000000000000000000000" }, to: { agentId: 10331 } });
  const review = handleOffer(offerArgs({ msg: withGrant }));
  assert.deepEqual(review.actions[0].payload.gas, { providerTxs: 2, grant: "1000000000000000000000" });
  assert.deepEqual(review.actions[0].payload.to, { agentId: 10331 });
  assert.equal(review.actions[0].payload.description, "keccak256 of a text");
  assert.equal(review.actions[0].payload.expiresAt, EXPIRES);

  // The operator's accept verdict on it: create_job only.
  const row = { ...review.ops[0].row, contextId: "ctx-1" };
  const msg = parsed("accept", { offerId: withGrant.offerId, party: { address: A, agentId: 10270 } });
  const o = handleAccept({ msg, offer: row, bound: true, now: T, config: cfg, counts: { createJobsToday: 0 }, verdict: true });
  assert.deepEqual(o.actions.map((a) => a.key), [`create_job:${withGrant.offerId}`]);
  const accepted = { ...row, state: "accepted", acceptedAddress: A, acceptedAgentId: 10270 };
  assert.equal(actionFor({ kind: "gas_grant", next: { ours: true, action: "create_job" }, offer: accepted, config: cfg }), null);
});

test("an inbound offer whose decimals or symbol differ from the configured token gets unsupported_terms", () => {
  assertError(handleOffer(offerArgs({ msg: { ...inboundOffer, price: { ...price, decimals: 18 } } })), "unsupported_terms", "price.decimals");
  assertError(handleOffer(offerArgs({ msg: { ...inboundOffer, price: { ...price, symbol: "USDT" } } })), "unsupported_terms", "price.symbol");
  assertError(handleOffer(offerArgs({ msg: { ...inboundOffer, price: { ...price, symbol: "usdc" } } })), "unsupported_terms", "price.symbol");
});

test("a job Defigent evaluates but did not create gets status only, never an evaluate action", () => {
  // A stranger's job that names us as evaluator, with no offer in our ledger.
  const foreign = job({ status: "Submitted", client: OTHER, provider: getAddress("0x4444444444444444444444444444444444444444"), budget: 250000n, paymentToken: USDC, submittedAt: T });
  const o = handleJobMessage(jobArgs({ offer: null, job: foreign, deliverable: HASH }));
  assert.equal(o.reply.name, "status");
  assert.deepEqual([o.reply.body.next.actor, o.reply.body.next.ours, o.reply.body.next.action], ["evaluator", false, "evaluate"]);
  assert.deepEqual(o.actions, []);
  assert.equal(o.taskState, "input-required");
  // actionFor refuses it even when told the step is ours.
  const forced = { ours: true, action: "evaluate", deadline: EXPIRES + 3600, urgent: false };
  assert.equal(actionFor({ kind: "evaluate", next: forced, job: foreign, offer: null, deliverable: HASH, config: cfg }), null);

  // Our own job (we are the client) queried by jobId with no offer: evaluate, with client and offerId in the payload.
  const ours = job({ status: "Submitted", budget: 250000n, paymentToken: USDC, submittedAt: T });
  const mine = handleJobMessage(jobArgs({ offer: null, job: ours, deliverable: HASH }));
  assert.deepEqual(mine.actions.map((a) => a.payload), [{
    jobId: "42", offerId: null, client: cfg.client, deadline: EXPIRES + 3600, urgent: false, deliverable: { hash: HASH, verified: true },
  }]);
});
