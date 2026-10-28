import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateJobsStore, createJobsStore } from "./store.mjs";

const OFFER_ID = "of_AbCdEf1234";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

const outOfferRow = {
  offerId: OFFER_ID,
  direction: "out",
  peerAgentId: 10270,
  peerAddress: null,
  peerEndpoint: "https://peer.example/inbox",
  contextId: OFFER_ID,
  terms: { offerId: OFFER_ID, price: { token: "USDC", amount: "250000" } },
  termsHash: "0x" + "ab".repeat(32),
  state: "open",
  expiresAt: 2000000000,
  createdAt: 1,
  updatedAt: 1,
};

const offer = (overrides) => ({ ...outOfferRow, ...overrides });
const fresh = () => { const db = new Database(":memory:"); migrateJobsStore(db); return createJobsStore(db); };

test("migration is idempotent", () => {
  const db = new Database(":memory:");
  migrateJobsStore(db);
  migrateJobsStore(db);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'job_%' ORDER BY name`).all().map((r) => r.name);
  assert.deepEqual(tables, ["job_actions", "job_claims", "job_offers", "job_replies", "job_seen"]);
});

test("insertOffer and getOffer round-trip an OfferRow with defaults", () => {
  const s = fresh();
  s.insertOffer(outOfferRow);
  assert.deepEqual(s.getOffer(OFFER_ID), {
    ...outOfferRow,
    acceptedAddress: null,
    acceptedAgentId: null,
    jobId: null,
    chainStatus: null,
    jobTerminal: false,
    deliverable: null,
    checkedAt: null,
  });
  assert.equal(s.getOffer("of_missing000"), null);
  assert.throws(() => s.insertOffer(outOfferRow), /UNIQUE|PRIMARY/);
});

test("only the first accept wins", () => {
  const s = fresh(); s.insertOffer(outOfferRow);
  assert.equal(s.acceptOffer(OFFER_ID, A, 10270, "ctx-peer", 1), true);
  assert.equal(s.acceptOffer(OFFER_ID, B, 10271, "ctx-other", 2), false);
  const o = s.getOffer(OFFER_ID);
  assert.equal(o.acceptedAddress, A);
  assert.equal(o.acceptedAgentId, 10270);
  assert.equal(o.state, "accepted");
  assert.equal(o.contextId, "ctx-peer");
  assert.equal(o.updatedAt, 1);
});

test("acceptOffer works from under_review and refuses declined, expired and unknown offers", () => {
  const s = fresh();
  s.insertOffer(offer({ offerId: "of_review0001", direction: "in", state: "under_review" }));
  s.insertOffer(offer({ offerId: "of_declined01", state: "declined" }));
  s.insertOffer(offer({ offerId: "of_expired001", state: "expired" }));
  assert.equal(s.acceptOffer("of_review0001", A, 10331, "c1", 5), true);
  assert.equal(s.getOffer("of_review0001").state, "accepted");
  assert.equal(s.acceptOffer("of_declined01", A, 10331, "c2", 5), false);
  assert.equal(s.acceptOffer("of_expired001", A, 10331, "c3", 5), false);
  assert.equal(s.acceptOffer("of_missing000", A, 10331, "c4", 5), false);
  assert.equal(s.getOffer("of_declined01").acceptedAddress, null);
});

test("offer updates set their field and updatedAt", () => {
  const s = fresh(); s.insertOffer(outOfferRow);
  s.setOfferState(OFFER_ID, "under_review", 3);
  assert.equal(s.getOffer(OFFER_ID).state, "under_review");
  s.linkJob(OFFER_ID, "42", 4);
  s.setChainStatus(OFFER_ID, "Funded", 5);
  s.setDeliverable(OFFER_ID, { hash: "0x" + "cd".repeat(32), uri: "ipfs://x" }, 6);
  s.markJobTerminal(OFFER_ID, 7);
  s.markChecked(OFFER_ID, 8);
  const o = s.getOffer(OFFER_ID);
  assert.equal(o.jobId, "42");
  assert.equal(o.chainStatus, "Funded");
  assert.deepEqual(o.deliverable, { hash: "0x" + "cd".repeat(32), uri: "ipfs://x" });
  assert.equal(o.jobTerminal, true);
  assert.equal(o.checkedAt, 8);
  assert.equal(o.updatedAt, 7);
  assert.deepEqual(s.findOfferByJobId("42"), o);
  assert.equal(s.findOfferByJobId("43"), null);
});

test("rememberResponse is keyed by sender and messageId", () => {
  const s = fresh();
  assert.equal(s.seenResponse(A, "m1"), null);
  s.rememberResponse(A, "m1", { kind: "status", n: 1 });
  s.rememberResponse(B, "m1", { kind: "status", n: 2 });
  s.rememberResponse(A, "m2", { kind: "status", n: 3 });
  assert.deepEqual(s.seenResponse(A, "m1"), { kind: "status", n: 1 });
  assert.deepEqual(s.seenResponse(B, "m1"), { kind: "status", n: 2 });
  assert.deepEqual(s.seenResponse(A, "m2"), { kind: "status", n: 3 });
  assert.equal(s.seenResponse("anon", "m1"), null);
  s.rememberResponse(A, "m1", { kind: "status", n: 9 });
  assert.deepEqual(s.seenResponse(A, "m1"), { kind: "status", n: 9 });
});

test("saveReply stores the body hash and response under the natural key", () => {
  const s = fresh();
  assert.equal(s.getReply("accept:of_AbCdEf1234"), null);
  s.saveReply("accept:of_AbCdEf1234", "0xhash1", { kind: "status", jobId: null });
  assert.deepEqual(s.getReply("accept:of_AbCdEf1234"), { bodyHash: "0xhash1", response: { kind: "status", jobId: null } });
  s.saveReply("accept:of_AbCdEf1234", "0xhash2", { kind: "status", jobId: "42" });
  assert.deepEqual(s.getReply("accept:of_AbCdEf1234"), { bodyHash: "0xhash2", response: { kind: "status", jobId: "42" } });
});

test("enqueueAction dedupes by key and unwoken actions are listed until woken", () => {
  const s = fresh();
  assert.equal(s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c", now: 1 }), true);
  assert.equal(s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c", now: 2 }), false);
  assert.equal(s.unwokenActions(10).length, 1); s.markWoken("fund:42", 3); assert.equal(s.unwokenActions(10).length, 0);
  assert.equal(s.getAction("fund:42").wokenAt, 3);
});

test("constraint violations throw instead of looking like a dedupe", () => {
  const s = fresh();
  assert.throws(() => s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c" }), /NOT NULL/);
  assert.equal(s.getAction("fund:42"), null);
  assert.throws(() => s.recordClaim({ replyId: "r1", name: "funded", body: {}, now: 1 }), /NOT NULL/);
  assert.equal(s.pendingClaims(10).length, 0);
});

test("actions round-trip as ActionRow and finishAction moves them out of pending", () => {
  const s = fresh();
  s.enqueueAction({ key: "fund:42", action: "fund", payload: { jobId: "42", token: A, amount: "250000" }, contextId: "c", now: 1 });
  s.enqueueAction({ key: "refund:43", action: "refund", payload: { jobId: "43" }, contextId: "d", now: 2 });
  assert.deepEqual(s.getAction("fund:42"), {
    key: "fund:42", action: "fund", payload: { jobId: "42", token: A, amount: "250000" }, contextId: "c",
    state: "pending", result: null, wokenAt: null, createdAt: 1, updatedAt: 1,
  });
  assert.equal(s.getAction("nope"), null);
  assert.deepEqual(s.listActions().map((a) => a.key), ["fund:42", "refund:43"]);
  s.finishAction("fund:42", "done", { txHash: "0xabc" }, 5);
  s.finishAction("refund:43", "failed", { error: "reverted" }, 6);
  assert.deepEqual(s.listActions(), []);
  assert.deepEqual(s.listActions("done").map((a) => [a.key, a.result, a.updatedAt]), [["fund:42", { txHash: "0xabc" }, 5]]);
  assert.deepEqual(s.listActions("failed").map((a) => a.key), ["refund:43"]);
  assert.deepEqual(s.unwokenActions(10), []);
});

test("unwokenActions respects the limit and the insertion order", () => {
  const s = fresh();
  for (let i = 1; i <= 3; i++) s.enqueueAction({ key: `fund:${i}`, action: "fund", payload: {}, contextId: "c", now: 10 });
  assert.deepEqual(s.unwokenActions(2).map((a) => a.key), ["fund:1", "fund:2"]);
});

test("countActionsSince counts only that action after the timestamp", () => {
  const s = fresh();
  s.enqueueAction({ key: "create_job:of_1", action: "create_job", payload: {}, contextId: "c", now: 100 });
  s.enqueueAction({ key: "create_job:of_2", action: "create_job", payload: {}, contextId: "c", now: 200 });
  s.enqueueAction({ key: "create_job:of_3", action: "create_job", payload: {}, contextId: "c", now: 300 });
  s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c", now: 300 });
  s.finishAction("create_job:of_3", "done", {}, 301);
  assert.equal(s.countActionsSince("create_job", 100), 2);
  assert.equal(s.countActionsSince("create_job", 99), 3);
  assert.equal(s.countActionsSince("create_job", 300), 0);
  assert.equal(s.countActionsSince("fund", 0), 1);
  assert.equal(s.countActionsSince("refund", 0), 0);
});

test("recordClaim dedupes by contextId + replyId", () => {
  const s = fresh();
  assert.equal(s.recordClaim({ contextId: "c", replyId: "r1", name: "funded", body: { jobId: "42" }, now: 1 }), true);
  assert.equal(s.recordClaim({ contextId: "c", replyId: "r1", name: "funded", body: { jobId: "42" }, now: 2 }), false);
  assert.equal(s.recordClaim({ contextId: "c", replyId: "r2", name: "submitted", body: { jobId: "42" }, now: 3 }), true);
  assert.equal(s.recordClaim({ contextId: "d", replyId: "r1", name: "funded", body: { jobId: "43" }, now: 4 }), true);
  const pending = s.pendingClaims(10);
  assert.deepEqual(pending.map((c) => [c.contextId, c.replyId, c.name]), [["c", "r1", "funded"], ["c", "r2", "submitted"], ["d", "r1", "funded"]]);
  assert.deepEqual(pending[0], { id: pending[0].id, contextId: "c", replyId: "r1", name: "funded", body: { jobId: "42" }, state: "pending", reason: null });
  assert.equal(s.pendingClaims(2).length, 2);
});

test("resolveClaim removes the claim from pendingClaims", () => {
  const s = fresh();
  s.recordClaim({ contextId: "c", replyId: "r1", name: "funded", body: {}, now: 1 });
  s.recordClaim({ contextId: "c", replyId: "r2", name: "completed", body: {}, now: 2 });
  const [first, second] = s.pendingClaims(10);
  s.resolveClaim(first.id, "verified", null, 5);
  s.resolveClaim(second.id, "rejected", "status is Funded", 6);
  assert.deepEqual(s.pendingClaims(10), []);
});

test("openJobOffers skips terminal jobs and offers without a job", () => {
  const s = fresh();
  s.insertOffer(offer({ offerId: "of_nojob00001" }));
  s.insertOffer(offer({ offerId: "of_live000001", createdAt: 1 }));
  s.insertOffer(offer({ offerId: "of_term000001" }));
  s.insertOffer(offer({ offerId: "of_live000002", createdAt: 2 }));
  s.linkJob("of_live000001", "41", 3);
  s.linkJob("of_term000001", "42", 3);
  s.linkJob("of_live000002", "43", 3);
  s.markJobTerminal("of_term000001", 4);
  assert.deepEqual(s.openJobOffers(10).map((o) => o.offerId), ["of_live000001", "of_live000002"]);
  assert.deepEqual(s.openJobOffers(1).map((o) => o.offerId), ["of_live000001"]);
});

test("openJobOffers returns the least recently checked jobs first", () => {
  const s = fresh();
  for (const [id, job] of [["of_live000001", "41"], ["of_live000002", "42"], ["of_live000003", "43"]]) {
    s.insertOffer(offer({ offerId: id, createdAt: Number(job) }));
    s.linkJob(id, job, 1);
  }
  s.markChecked("of_live000001", 20);
  s.markChecked("of_live000002", 10);
  assert.deepEqual(s.openJobOffers(10).map((o) => o.offerId), ["of_live000003", "of_live000002", "of_live000001"]);
  s.markChecked("of_live000003", 30);
  assert.deepEqual(s.openJobOffers(1).map((o) => o.offerId), ["of_live000002"]);
});

test("countOpenOffersForAgent counts only open and under_review offers of that agent", () => {
  const s = fresh();
  s.insertOffer(offer({ offerId: "of_open000001", peerAgentId: 10270, state: "open" }));
  s.insertOffer(offer({ offerId: "of_review0001", peerAgentId: 10270, state: "under_review", direction: "in" }));
  s.insertOffer(offer({ offerId: "of_accept0001", peerAgentId: 10270, state: "open" }));
  s.acceptOffer("of_accept0001", A, 10331, "c", 2);
  s.insertOffer(offer({ offerId: "of_declined01", peerAgentId: 10270, state: "declined" }));
  s.insertOffer(offer({ offerId: "of_other00001", peerAgentId: 10271, state: "open" }));
  assert.equal(s.countOpenOffersForAgent(10270, 1000), 2);
  assert.equal(s.countOpenOffersForAgent(10271, 1000), 1);
  assert.equal(s.countOpenOffersForAgent(99999, 1000), 0);
  // An 'open' offer whose expires_at <= now is not counted.
  s.insertOffer(offer({ offerId: "of_stale00001", peerAgentId: 10272, state: "open", expiresAt: 1500 }));
  assert.equal(s.countOpenOffersForAgent(10272, 1499), 1);
  assert.equal(s.countOpenOffersForAgent(10272, 1500), 0);
});

test("transaction rolls back every write when fn throws", () => {
  const s = fresh();
  assert.throws(() => s.transaction(() => {
    s.insertOffer(outOfferRow);
    s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c", now: 1 });
    throw new Error("boom");
  }), /boom/);
  assert.equal(s.getOffer(OFFER_ID), null);
  assert.equal(s.getAction("fund:42"), null);
  assert.equal(s.transaction(() => s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c", now: 1 })), true);
  assert.equal(s.getAction("fund:42").state, "pending");
});
