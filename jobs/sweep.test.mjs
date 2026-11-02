import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getAddress, zeroAddress } from "viem";
import { ChainUnavailable } from "./chain.mjs";
import { loadJobsConfig } from "./config.mjs";
import { createFakeChain } from "./fake_chain.mjs";
import { jobDescription, parseTyped, termsHash } from "./protocol.mjs";
import { createJobsRuntime } from "./runtime.mjs";
import { createJobsStore, migrateJobsStore } from "./store.mjs";
import { sweepJobs } from "./sweep.mjs";

const cfg = loadJobsConfig({ env: {} });
const USDC = cfg.tokens.USDC.address;
const A = getAddress("0xabc0000000000000000000000000000000000001");
const B = getAddress("0xabc0000000000000000000000000000000000002");
const T = 1792000000;
const EXPIRES = T + 86400;
const HASH = `0x${"ab".repeat(32)}`;
const OFFER_ID = "of_AbCdEf1234";
const INBOUND_ID = "of_InBound123";
const SET_BUDGET = "setBudget(uint256,address,uint256,bytes)";

function parsed(name, body) {
  const r = parseTyped(name, body);
  assert.equal(r.ok, true, `${name}: ${r.field} ${r.detail}`);
  return r.value;
}

const price = { amount: "250000", token: USDC, decimals: 6, symbol: "USDC" };
const outTerms = parsed("offer", {
  offerId: OFFER_ID, side: "client", service: "a2a-conformance-probe", description: "Answer tasks/get and return the raw response.",
  price, settlement: { chainId: 143, escrow: cfg.escrow }, deliverable: { mediaType: "application/json", acceptance: "operator" },
  gas: { providerTxs: 2, grant: null }, from: { address: cfg.client, agentId: 10331 },
  replyTo: { url: "https://defigent.example/inbox", contextId: OFFER_ID }, expiresAt: EXPIRES,
});
// Our offer, accepted by A on its own contextId and not yet linked to a job.
const acceptedRow = {
  offerId: OFFER_ID, direction: "out", peerAgentId: 10270, peerAddress: null, peerEndpoint: "https://peer.example/a2a",
  contextId: "ctx-accept", terms: outTerms, termsHash: termsHash(outTerms), state: "accepted", expiresAt: EXPIRES,
  acceptedAddress: A, acceptedAgentId: 10270, createdAt: T - 60,
};
const linkedRow = (overrides = {}) => ({ ...acceptedRow, jobId: "42", chainStatus: "Funded", ...overrides });

const inboundTerms = parsed("offer", {
  offerId: INBOUND_ID, side: "provider", service: "hash-text", description: "keccak256 of a text",
  price, settlement: { chainId: 143, escrow: cfg.escrow }, deliverable: { mediaType: "text/plain", acceptance: "operator" },
  from: { address: A, agentId: 10270 }, expiresAt: EXPIRES,
});
const inboundRow = {
  offerId: INBOUND_ID, direction: "in", peerAgentId: 10270, peerAddress: A, peerEndpoint: null, contextId: "ctx-offer",
  terms: inboundTerms, termsHash: termsHash(inboundTerms), state: "under_review", expiresAt: EXPIRES, createdAt: T - 60,
};

const job = (overrides = {}) => ({
  client: cfg.client, status: "Open", provider: A, expiredAt: EXPIRES, evaluator: cfg.evaluator, submittedAt: 0, budget: 0n,
  hook: cfg.hook, paymentToken: zeroAddress, providerAgentId: 10270n, description: jobDescription(outTerms), settledAmount: 0n,
  payoutReceiver: zeroAddress, ...overrides,
});
const chain = (overrides = {}) => createFakeChain({ jobs: { 42: job() }, bindings: [{ address: A, agentId: 10270 }], allowedTokens: [USDC], now: T, ...overrides });

function setup({ offers = [], reader = chain() } = {}) {
  const db = new Database(":memory:");
  migrateJobsStore(db);
  const store = createJobsStore(db);
  for (const o of offers) store.insertOffer(o);
  const woken = [];
  const updates = [];
  const sweep = (opts = {}) => sweepJobs({
    store, reader, config: cfg, now: T, onAction: (row) => woken.push(row), onTaskUpdate: (u) => updates.push(u), ...opts,
  });
  return { db, store, reader, woken, updates, sweep };
}

const claim = (store, name, body, { contextId = "ctx-accept", replyId = `${name}-reply` } = {}) => {
  store.recordClaim({ contextId, replyId, name, body: parsed(name, body), now: T });
  return store.pendingClaims(100).at(-1);
};
const claimState = (store, db, id) => db.prepare("SELECT state, reason FROM job_claims WHERE id=?").get(id);

test("a verified created claim links the job and moves the offer task to setBudget", async () => {
  const { db, store, woken, updates, sweep } = setup({ offers: [acceptedRow] });
  const c = claim(store, "created", { offerId: OFFER_ID, jobId: "42" }, { replyId: `create_job:${OFFER_ID}` });

  const r = await sweep();

  assert.deepEqual(claimState(store, db, c.id), { state: "verified", reason: null });
  const o = store.getOffer(OFFER_ID);
  assert.equal(o.jobId, "42");
  assert.equal(o.chainStatus, "Open");
  assert.equal(o.jobTerminal, false);
  assert.deepEqual(r.claims, [{ id: c.id, name: "created", state: "verified", reason: null }]);
  // One update for the claim; the open-jobs pass sees no further change.
  assert.equal(updates.length, 1);
  const u = updates[0];
  assert.equal(u.contextId, "ctx-accept");
  assert.equal(u.state, "input-required");
  assert.equal(u.name, "status");
  assert.equal(u.body.job.jobId, "42");
  assert.equal(u.body.job.chainStatus, "Open");
  assert.equal(u.body.next.actor, "provider");
  assert.equal(u.body.next.function, SET_BUDGET);
  assert.deepEqual(u.body.next.args, ["42", USDC, "250000", "0x"]);
  assert.equal(u.text, u.body.next.note);
  assert.deepEqual(r.updates, updates);
  assert.deepEqual(store.listActions(), []);
  assert.deepEqual(woken, []);
});

test("a created claim takes the offerId from the create_job replyId when the body has none", async () => {
  const { db, store, sweep } = setup({ offers: [acceptedRow] });
  const c = claim(store, "created", { jobId: "42" }, { replyId: `create_job:${OFFER_ID}` });
  await sweep();
  assert.equal(claimState(store, db, c.id).state, "verified");
  assert.equal(store.getOffer(OFFER_ID).jobId, "42");
});

test("a created claim with the wrong provider is rejected and raises review_claim", async () => {
  const { db, store, woken, updates, sweep } = setup({ offers: [acceptedRow], reader: chain({ jobs: { 42: job({ provider: B }) } }) });
  const c = claim(store, "created", { offerId: OFFER_ID, jobId: "42" }, { replyId: `create_job:${OFFER_ID}` });

  const r = await sweep();

  const reason = `job 42 provider ${B} is not the accepted address ${A}`;
  assert.deepEqual(claimState(store, db, c.id), { state: "rejected", reason });
  assert.deepEqual(r.claims, [{ id: c.id, name: "created", state: "rejected", reason }]);
  assert.equal(store.getOffer(OFFER_ID).jobId, null);
  const key = `review_claim:${c.id}`;
  assert.deepEqual(store.listActions().map((a) => [a.key, a.contextId]), [[key, "ctx-accept"]]);
  assert.deepEqual(store.getAction(key).payload, { claimId: c.id, name: "created", body: { offerId: OFFER_ID, jobId: "42" }, reason });
  assert.deepEqual(r.actions.map((a) => a.key), [key]);
  assert.deepEqual(woken.map((a) => a.key), [key]);
  assert.deepEqual(updates, []);
});

test("a created claim is rejected when the client, agentId or description do not match", async () => {
  const otherTerms = { ...outTerms, offerId: "of_Other12345" };
  for (const [overrides, reason] of [
    [{ client: B }, `job 42 client ${B} is not ${cfg.client}`],
    [{ providerAgentId: 7n }, "job 42 provider agent 7 is not the accepted agent 10270"],
    [{ description: jobDescription(otherTerms) }, `job 42 description does not point to offer ${OFFER_ID} and its terms`],
    [{ description: "free text" }, `job 42 description does not point to offer ${OFFER_ID} and its terms`],
  ]) {
    const { db, store, sweep } = setup({ offers: [acceptedRow], reader: chain({ jobs: { 42: job(overrides) } }) });
    const c = claim(store, "created", { offerId: OFFER_ID, jobId: "42" });
    await sweep();
    assert.deepEqual(claimState(store, db, c.id), { state: "rejected", reason });
    assert.equal(store.getOffer(OFFER_ID).jobId, null);
  }
});

test("silent submit: a Submitted job without a notice gets evaluate with the grace deadline", async () => {
  const reader = chain({ jobs: { 42: job({ status: "Submitted", submittedAt: T - 100, budget: 250000n, paymentToken: USDC }) }, deliverables: { 42: HASH } });
  const { store, woken, updates, sweep } = setup({ offers: [linkedRow()], reader });

  const r = await sweep();

  const key = "evaluate:42";
  assert.deepEqual(store.listActions().map((a) => [a.key, a.contextId]), [[key, "ctx-accept"]]);
  assert.deepEqual(store.getAction(key).payload, {
    jobId: "42", offerId: OFFER_ID, client: cfg.client, deadline: EXPIRES + 3600, urgent: false, deliverable: { hash: HASH, verified: true },
  });
  assert.deepEqual(r.actions.map((a) => a.key), [key]);
  assert.deepEqual(woken.map((a) => a.key), [key]);
  assert.equal(store.getAction(key).wokenAt, T);
  const o = store.getOffer(OFFER_ID);
  assert.equal(o.chainStatus, "Submitted");
  assert.equal(o.checkedAt, T);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].contextId, "ctx-accept");
  assert.equal(updates[0].state, "working");
  assert.equal(updates[0].body.next.action, "evaluate");
  assert.deepEqual(updates[0].body.job.deliverable, { hash: HASH, verified: true });
});

test("a Submitted job someone already refunded (Expired) gets no evaluate and turns terminal", async () => {
  const reader = chain({ jobs: { 42: job({ status: "Expired", submittedAt: T - 100, budget: 250000n, paymentToken: USDC }) } });
  const { store, updates, sweep } = setup({ offers: [linkedRow({ chainStatus: "Submitted" })], reader });

  const r = await sweep();

  assert.deepEqual(store.listActions(), []);
  assert.deepEqual(r.actions, []);
  const o = store.getOffer(OFFER_ID);
  assert.equal(o.chainStatus, "Expired");
  assert.equal(o.jobTerminal, true);
  assert.deepEqual(store.openJobOffers(10), []);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].state, "failed");
  assert.equal(updates[0].body.job.chainStatus, "Expired");
  assert.equal(updates[0].body.next.actor, null);
});

test("a Funded job past expiry with a pending claim gets no refund", async () => {
  const reader = chain({ jobs: { 42: job({ status: "Funded", expiredAt: T - 10, budget: 250000n, paymentToken: USDC }) }, pendingClaims: ["42"] });
  const { store, updates, sweep } = setup({ offers: [linkedRow()], reader });

  const r = await sweep();

  assert.deepEqual(store.listActions(), []);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(updates, [], "the chain status did not change");
  const o = store.getOffer(OFFER_ID);
  assert.equal(o.jobTerminal, false);
  assert.equal(o.checkedAt, T);
});

test("a Funded job past expiry gets refund only once across two sweeps", async () => {
  const reader = chain({ jobs: { 42: job({ status: "Funded", expiredAt: T - 10, budget: 250000n, paymentToken: USDC }) } });
  const { store, woken, sweep } = setup({ offers: [linkedRow()], reader });

  const first = await sweep();
  const second = await sweep();

  assert.deepEqual(first.actions.map((a) => a.key), ["refund:42"]);
  assert.deepEqual(second.actions, []);
  assert.deepEqual(store.listActions().map((a) => [a.key, a.payload]), [["refund:42", { jobId: "42" }]]);
  assert.deepEqual(woken.map((a) => a.key), ["refund:42"]);
});

test("actions enqueued by a script are woken exactly once", async () => {
  const { store, woken, sweep } = setup();
  store.enqueueAction({ key: "fund:42", action: "fund", payload: { jobId: "42", token: USDC, amount: "250000" }, contextId: "ctx-accept", now: T - 5 });

  await sweep();
  await sweep();

  assert.deepEqual(woken.map((a) => [a.key, a.action, a.contextId]), [["fund:42", "fund", "ctx-accept"]]);
  assert.deepEqual(woken[0].payload, { jobId: "42", token: USDC, amount: "250000" });
  assert.equal(store.getAction("fund:42").wokenAt, T);
});

test("without onAction the sweep leaves actions unwoken", async () => {
  const { store, sweep } = setup();
  store.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "ctx-accept", now: T - 5 });
  await sweep({ onAction: undefined });
  assert.equal(store.getAction("fund:42").wokenAt, null);
});

test("maxReads bounds the chain reads per sweep", async () => {
  const ids = ["1", "2", "3", "4", "5"];
  const reader = chain({ jobs: Object.fromEntries(ids.map((id) => [id, job({ status: "Funded", budget: 250000n, paymentToken: USDC })])) });
  const offers = ids.map((id, i) => linkedRow({ offerId: `of_Sweep0000${id}`, jobId: id, createdAt: T - 100 + i }));
  const { store, sweep } = setup({ offers, reader });

  // Each open job costs three reads (getJob, pendingClaimHash, block time), so seven reads cover two jobs.
  await sweep({ maxReads: 7 });
  assert.equal(reader.calls, 6);
  assert.deepEqual(offers.map((o) => store.getOffer(o.offerId).checkedAt), [T, T, null, null, null]);

  // The least recently checked jobs go first (R23).
  await sweep({ maxReads: 7, now: T + 1 });
  assert.equal(reader.calls, 12);
  assert.deepEqual(offers.map((o) => store.getOffer(o.offerId).checkedAt), [T, T, T + 1, T + 1, null]);
});

test("maxReads also bounds the claims", async () => {
  const { db, store, reader, sweep } = setup({ offers: [linkedRow()], reader: chain({ jobs: { 42: job({ status: "Funded" }) } }) });
  const c1 = claim(store, "funded", { jobId: "42" }, { replyId: "fund:42" });
  const c2 = claim(store, "funded", { jobId: "42" }, { replyId: "fund:42-again" });
  await sweep({ maxReads: 1 });
  assert.equal(reader.calls, 1);
  assert.equal(claimState(store, db, c1.id).state, "verified");
  assert.equal(claimState(store, db, c2.id).state, "pending");
});

test("chain unavailable stops the sweep without changing state", async () => {
  const reader = chain({ jobs: { 42: job(), 43: job({ status: "Submitted", budget: 250000n, paymentToken: USDC }) } });
  const { db, store, woken, updates, sweep } = setup({ offers: [acceptedRow, linkedRow({ offerId: "of_Linked1234", jobId: "43" })], reader });
  const c = claim(store, "created", { offerId: OFFER_ID, jobId: "42" });
  store.enqueueAction({ key: "fund:7", action: "fund", payload: {}, contextId: "ctx-x", now: T - 5 });
  reader.setFail(true);

  const r = await sweep();

  assert.deepEqual(r, { claims: [], actions: [], updates: [] });
  assert.deepEqual(claimState(store, db, c.id), { state: "pending", reason: null });
  assert.equal(store.getOffer(OFFER_ID).jobId, null);
  const linked = store.getOffer("of_Linked1234");
  assert.equal(linked.chainStatus, "Funded");
  assert.equal(linked.checkedAt, null);
  assert.deepEqual(store.listActions().map((a) => a.key), ["fund:7"]);
  assert.equal(store.getAction("fund:7").wokenAt, null);
  assert.deepEqual(woken, []);
  assert.deepEqual(updates, []);

  // Once the chain answers again, the next sweep does the work.
  reader.setFail(false);
  const again = await sweep();
  assert.equal(claimState(store, db, c.id).state, "verified");
  assert.deepEqual(again.actions.map((a) => a.key), ["evaluate:43"]);
});

test("a chain failure in the middle of a job leaves that job untouched", async () => {
  const reader = chain({ jobs: { 42: job({ status: "Submitted", budget: 250000n, paymentToken: USDC }) } });
  // getJob, pendingClaimHash and the block time answer; the JobSubmitted lookup does not.
  const failing = { ...reader, submittedDeliverable: () => Promise.reject(new ChainUnavailable("JobSubmitted logs: down")) };
  const { store, updates, sweep } = setup({ offers: [linkedRow()], reader: failing });

  const r = await sweep();

  assert.deepEqual(r, { claims: [], actions: [], updates: [] });
  const o = store.getOffer(OFFER_ID);
  assert.equal(o.chainStatus, "Funded");
  assert.equal(o.checkedAt, null);
  assert.deepEqual(store.listActions(), []);
  assert.deepEqual(updates, []);
});

test("a funded claim is verified when the chain is already past Funded (R32)", async () => {
  const reader = chain({ jobs: { 42: job({ status: "Submitted", budget: 250000n, paymentToken: USDC }) } });
  const { db, store, updates, sweep } = setup({ offers: [linkedRow({ chainStatus: "Open" })], reader });
  const c = claim(store, "funded", { jobId: "42" }, { replyId: "fund:42" });

  await sweep({ maxReads: 1 });

  assert.deepEqual(claimState(store, db, c.id), { state: "verified", reason: null });
  assert.equal(store.getOffer(OFFER_ID).chainStatus, "Submitted");
  assert.equal(store.getOffer(OFFER_ID).jobTerminal, false);
  assert.deepEqual(store.listActions(), [], "no review_claim");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].contextId, "ctx-accept");
  assert.equal(updates[0].body.job.chainStatus, "Submitted");
});

test("a terminal claim needs the exact terminal status", async () => {
  const done = setup({ offers: [linkedRow({ chainStatus: "Submitted" })], reader: chain({ jobs: { 42: job({ status: "Completed" }) } }) });
  const ok = claim(done.store, "completed", { jobId: "42" }, { replyId: "evaluate:42" });
  await done.sweep({ maxReads: 1 });
  assert.equal(claimState(done.store, done.db, ok.id).state, "verified");
  assert.equal(done.store.getOffer(OFFER_ID).jobTerminal, true);
  assert.equal(done.store.getOffer(OFFER_ID).chainStatus, "Completed");
  assert.equal(done.updates[0].state, "completed");

  const wrong = setup({ offers: [linkedRow({ chainStatus: "Submitted" })], reader: chain({ jobs: { 42: job({ status: "Rejected" }) } }) });
  const bad = claim(wrong.store, "completed", { jobId: "42" }, { replyId: "evaluate:42" });
  await wrong.sweep({ maxReads: 1 });
  const reason = "job 42 is Rejected on chain, not Completed";
  assert.deepEqual(claimState(wrong.store, wrong.db, bad.id), { state: "rejected", reason });
  assert.equal(wrong.store.getOffer(OFFER_ID).jobTerminal, false);
  assert.deepEqual(wrong.store.listActions().map((a) => a.key), [`review_claim:${bad.id}`]);
  assert.deepEqual(wrong.updates, []);

  const early = setup({ offers: [linkedRow({ chainStatus: "Open" })], reader: chain({ jobs: { 42: job({ status: "Open" }) } }) });
  const tooSoon = claim(early.store, "funded", { jobId: "42" }, { replyId: "fund:42" });
  await early.sweep({ maxReads: 1 });
  assert.deepEqual(claimState(early.store, early.db, tooSoon.id), { state: "rejected", reason: "job 42 is Open on chain, not Funded or later" });
});

test("the operator's accept verdict accepts the inbound offer and raises create_job", async () => {
  const { db, store, woken, updates, sweep } = setup({ offers: [inboundRow] });
  const c = claim(store, "accept", { offerId: INBOUND_ID, party: { address: A, agentId: 10270 } }, { contextId: "ctx-offer", replyId: `review_offer:${INBOUND_ID}` });

  const r = await sweep({ maxReads: 1 });

  assert.deepEqual(claimState(store, db, c.id), { state: "verified", reason: null });
  const o = store.getOffer(INBOUND_ID);
  assert.equal(o.state, "accepted");
  assert.equal(o.acceptedAddress, A);
  assert.equal(o.acceptedAgentId, 10270);
  assert.equal(o.contextId, "ctx-offer");
  const key = `create_job:${INBOUND_ID}`;
  assert.deepEqual(store.listActions().map((a) => [a.key, a.contextId]), [[key, "ctx-offer"]]);
  assert.deepEqual(store.getAction(key).payload, {
    offerId: INBOUND_ID, provider: A, agentId: 10270, evaluator: cfg.evaluator, hook: cfg.hook, expiredAt: EXPIRES,
    description: jobDescription(inboundTerms), token: USDC, amount: "250000",
  });
  assert.deepEqual(r.actions.map((a) => a.key), [key]);
  assert.deepEqual(woken.map((a) => a.key), [key]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].contextId, "ctx-offer");
  assert.equal(updates[0].state, "working");
  assert.deepEqual(updates[0].body.offer, { offerId: INBOUND_ID, state: "accepted" });
  assert.equal(updates[0].body.next.action, "create_job");
});

test("an accept verdict for a party that is not bound to the agent is rejected", async () => {
  const { db, store, updates, sweep } = setup({ offers: [inboundRow] });
  const c = claim(store, "accept", { offerId: INBOUND_ID, party: { address: B, agentId: 10270 } }, { contextId: "ctx-offer" });

  await sweep();

  const reason = `${B} is neither the owner nor the agent wallet of agent 10270.`;
  assert.deepEqual(claimState(store, db, c.id), { state: "rejected", reason });
  assert.equal(store.getOffer(INBOUND_ID).state, "under_review");
  assert.deepEqual(store.listActions().map((a) => a.key), [`review_claim:${c.id}`]);
  assert.deepEqual(updates, []);
});

test("an accept verdict for another agent than the offer's sender is rejected", async () => {
  const reader = chain({ bindings: [{ address: A, agentId: 10270 }, { address: B, agentId: 10271 }] });
  const { db, store, sweep } = setup({ offers: [inboundRow], reader });
  const c = claim(store, "accept", { offerId: INBOUND_ID, party: { address: B, agentId: 10271 } }, { contextId: "ctx-offer" });
  await sweep();
  assert.deepEqual(claimState(store, db, c.id), { state: "rejected", reason: `Offer ${INBOUND_ID} came from agent 10270, not 10271.` });
  assert.equal(store.getOffer(INBOUND_ID).state, "under_review");
});

test("an accept verdict that hits the daily create_job cap stays pending", async () => {
  const { db, store, reader, sweep } = setup({ offers: [inboundRow] });
  for (let i = 0; i < cfg.caps.maxCreateJobPerDay; i += 1)
    store.enqueueAction({ key: `create_job:of_Capped0${String(i).padStart(3, "0")}`, action: "create_job", payload: {}, contextId: "x", now: T - 60 });
  const c = claim(store, "accept", { offerId: INBOUND_ID, party: { address: A, agentId: 10270 } }, { contextId: "ctx-offer" });

  await sweep();

  assert.deepEqual(claimState(store, db, c.id), { state: "pending", reason: null });
  assert.equal(store.getOffer(INBOUND_ID).state, "under_review");
  assert.equal(store.listActions().some((a) => a.action === "review_claim"), false);
  assert.equal(reader.calls, 1);
});

test("the operator's decline verdict declines the inbound offer without reading the chain", async () => {
  const { db, store, reader, updates, sweep } = setup({ offers: [inboundRow] });
  const c = claim(store, "decline", { offerId: INBOUND_ID, reason: "price" }, { contextId: "ctx-offer", replyId: `review_offer:${INBOUND_ID}` });

  await sweep();

  assert.deepEqual(claimState(store, db, c.id), { state: "verified", reason: null });
  assert.equal(store.getOffer(INBOUND_ID).state, "declined");
  assert.equal(reader.calls, 0);
  assert.deepEqual(store.listActions(), []);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].contextId, "ctx-offer");
  assert.equal(updates[0].state, "rejected");
  assert.deepEqual(updates[0].body.offer, { offerId: INBOUND_ID, state: "declined" });
});

test("runtime.sweep runs the sweep with the runtime's clock and callbacks", async () => {
  const updates = [];
  const woken = [];
  const rt = createJobsRuntime({
    db: new Database(":memory:"), config: cfg, reader: chain(), clock: () => T, onAction: (row) => woken.push(row), onTaskUpdate: (u) => updates.push(u),
  });
  rt.store.insertOffer(acceptedRow);
  rt.store.recordClaim({ contextId: "ctx-accept", replyId: `create_job:${OFFER_ID}`, name: "created", body: { offerId: OFFER_ID, jobId: "42" }, now: T });

  const r = await rt.sweep();

  assert.deepEqual(r.claims.map((c) => [c.name, c.state]), [["created", "verified"]]);
  assert.equal(rt.store.getOffer(OFFER_ID).jobId, "42");
  assert.equal(rt.store.getOffer(OFFER_ID).checkedAt, T);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].body.next.function, SET_BUDGET);
  assert.deepEqual(woken, []);
});

test("evaluate turns urgent near the deadline: the pending action gets the urgent payload and is woken once more", async () => {
  const submitted = { 42: job({ status: "Submitted", submittedAt: T - 100, budget: 250000n, paymentToken: USDC }) };
  const { store, woken, sweep } = setup({ offers: [linkedRow()], reader: chain({ jobs: submitted, deliverables: { 42: HASH } }) });
  const key = "evaluate:42";

  await sweep();
  assert.equal(store.getAction(key).payload.urgent, false);
  assert.deepEqual(woken.map((a) => a.key), [key]);

  // Two hours before expiredAt + 1 h: inside the last 6 h, so the step is urgent.
  const late = EXPIRES + 3600 - 7200;
  const lateChain = chain({ jobs: submitted, deliverables: { 42: HASH }, now: late });
  const r = await sweep({ reader: lateChain, now: late });
  assert.deepEqual(r.actions.map((a) => a.key), [key]);
  const row = store.getAction(key);
  assert.equal(row.state, "pending");
  assert.equal(row.payload.urgent, true);
  assert.equal(row.payload.deadline, EXPIRES + 3600);
  assert.equal(row.wokenAt, late);
  assert.deepEqual(woken.map((a) => [a.key, a.payload.urgent]), [[key, false], [key, true]]);

  // Once urgent, later sweeps neither rewrite nor wake it again.
  const again = await sweep({ reader: lateChain, now: late + 600 });
  assert.deepEqual(again.actions, []);
  assert.equal(woken.length, 2);
  assert.equal(store.getAction(key).wokenAt, late);
});

test("a done evaluate is never reopened by an urgent sweep", async () => {
  const submitted = { 42: job({ status: "Submitted", submittedAt: T - 100, budget: 250000n, paymentToken: USDC }) };
  const { store, woken, sweep } = setup({ offers: [linkedRow()], reader: chain({ jobs: submitted }) });
  await sweep();
  store.finishAction("evaluate:42", "done", { verdict: "complete" }, T + 1);
  const late = EXPIRES + 3600 - 7200;
  await sweep({ reader: chain({ jobs: submitted, now: late }), now: late });
  assert.equal(store.getAction("evaluate:42").state, "done");
  assert.equal(store.getAction("evaluate:42").payload.urgent, false);
  assert.equal(woken.length, 1);
});
