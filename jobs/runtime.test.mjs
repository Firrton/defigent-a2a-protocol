import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getAddress, zeroAddress } from "viem";
import { loadJobsConfig } from "./config.mjs";
import { createFakeChain } from "./fake_chain.mjs";
import { jobDescription, parseTyped, termsHash } from "./protocol.mjs";
import { createJobsRuntime } from "./runtime.mjs";

const cfg = loadJobsConfig({ env: {} });
const USDC = cfg.tokens.USDC.address;
const A = getAddress("0xabc0000000000000000000000000000000000001");
const B = getAddress("0xabc0000000000000000000000000000000000002");
const T = 1792000000;
const EXPIRES = T + 86400;
const HASH = `0x${"ab".repeat(32)}`;
const OFFER_ID = "of_AbCdEf1234";
const clock = () => T;

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
const outOfferRow = {
  offerId: OFFER_ID, direction: "out", peerAgentId: 10270, peerAddress: null, peerEndpoint: "https://peer.example/a2a",
  contextId: OFFER_ID, terms: outTerms, termsHash: termsHash(outTerms), state: "open", expiresAt: EXPIRES, createdAt: T - 60,
};
const linkedRow = { ...outOfferRow, state: "accepted", acceptedAddress: A, acceptedAgentId: 10270, jobId: "42" };

const inboundBody = {
  offerId: "of_InBound123", side: "provider", service: "hash-text", description: "keccak256 of a text",
  price, settlement: { chainId: 143, escrow: cfg.escrow }, deliverable: { mediaType: "text/plain", acceptance: "operator" },
  from: { address: A, agentId: 10270 }, expiresAt: EXPIRES,
};

const job = (overrides = {}) => ({
  client: cfg.client, status: "Open", provider: A, expiredAt: EXPIRES, evaluator: cfg.evaluator, submittedAt: 0, budget: 0n,
  hook: cfg.hook, paymentToken: zeroAddress, providerAgentId: 10270n, description: jobDescription(outTerms), settledAmount: 0n,
  payoutReceiver: zeroAddress, ...overrides,
});

const chain = (overrides = {}) => createFakeChain({
  jobs: { 42: job() }, bindings: [{ address: A, agentId: 10270 }, { address: B, agentId: 10271 }], allowedTokens: [USDC], now: T, ...overrides,
});
const fake = chain();

const typed = (name, body, messageId, { contextId = "ctx-peer", sender = "0xpeer" } = {}) =>
  ({ detection: { kind: "typed", name, body }, contextId, sender, messageId });
const acceptReq = (messageId, party = { address: A, agentId: 10270 }, contextId = "ctx-accept") =>
  typed("accept", { offerId: OFFER_ID, party }, messageId, { contextId });
const queryReq = (messageId, body = { jobId: "42" }) => typed("query", body, messageId, { sender: null });
const offerReq = (messageId, body = inboundBody) => typed("offer", body, messageId, { contextId: "ctx-offer" });

const createJobs = (store) => store.listActions().filter((x) => x.action === "create_job");

test("accepting our offer: status accepted, one create_job action, onAction called once", async () => {
  const woken = [];
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock, onAction: (row) => woken.push(row) });
  rt.store.insertOffer(outOfferRow);
  const r = await rt.process(acceptReq("m1"));

  assert.equal(r.kind, "ok");
  assert.equal(r.name, "status");
  assert.deepEqual(r.body.offer, { offerId: OFFER_ID, state: "accepted" });
  assert.equal(r.body.next.action, "create_job");
  assert.equal(r.text, r.body.next.note);
  assert.equal(r.taskState, "working");
  const key = `create_job:${OFFER_ID}`;
  assert.deepEqual(r.actions.map((a) => a.key), [key]);
  assert.deepEqual(r.actions[0].payload, {
    offerId: OFFER_ID, provider: A, agentId: 10270, evaluator: cfg.evaluator, hook: cfg.hook, expiredAt: EXPIRES,
    description: jobDescription(outTerms), token: USDC, amount: "250000",
  });
  assert.equal(r.actions[0].contextId, "ctx-accept");

  assert.equal(woken.length, 1);
  assert.equal(woken[0].key, key);
  assert.equal(rt.store.getAction(key).wokenAt, T);
  // The accepting request's contextId becomes the offer's (R6).
  const o = rt.store.getOffer(OFFER_ID);
  assert.equal(o.state, "accepted");
  assert.equal(o.acceptedAddress, A);
  assert.equal(o.acceptedAgentId, 10270);
  assert.equal(o.contextId, "ctx-accept");
  assert.deepEqual(rt.store.seenResponse("0xpeer", "m1"), { ...r, actions: [] });
});

test("without onAction new actions stay unwoken for the sweep", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  rt.store.insertOffer(outOfferRow);
  const r = await rt.process(acceptReq("m1"));
  assert.deepEqual(r.actions.map((a) => a.key), [`create_job:${OFFER_ID}`]);
  assert.equal(rt.store.getAction(`create_job:${OFFER_ID}`).wokenAt, null);
});

test("the same accept after a restart replays the stored reply without a second action", async () => {
  const db = new Database(":memory:");
  const woken = [];
  const r1 = createJobsRuntime({ db, config: cfg, reader: fake, clock, onAction: (row) => woken.push(row) });
  r1.store.insertOffer(outOfferRow);
  const a = await r1.process(acceptReq("m1"));
  const calls = fake.calls;
  const r2 = createJobsRuntime({ db, config: cfg, reader: fake, clock, onAction: (row) => woken.push(row) });
  const b = await r2.process(acceptReq("m2")); // new messageId, same body
  assert.deepEqual(b.body, a.body);
  assert.equal(b.taskState, "working");
  assert.deepEqual(b.actions, []);
  assert.equal(fake.calls, calls, "a replay reads nothing from the chain");
  assert.equal(woken.length, 1);
  assert.equal(createJobs(r2.store).length, 1);
  assert.deepEqual(r2.store.seenResponse("0xpeer", "m2"), b);
});

test("a different accept for a taken offer gets offer_taken", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  rt.store.insertOffer(outOfferRow);
  await rt.process(acceptReq("m1"));
  const r = await rt.process(acceptReq("m2", { address: B, agentId: 10271 }, "ctx-other"));
  assert.equal(r.name, "error");
  assert.equal(r.body.code, "offer_taken");
  assert.equal(r.body.retryable, false);
  assert.equal(r.taskState, "rejected");
  assert.deepEqual(r.actions, []);
  assert.equal(rt.store.getOffer(OFFER_ID).acceptedAddress, A);
  assert.equal(rt.store.getOffer(OFFER_ID).contextId, "ctx-accept");
  assert.equal(createJobs(rt.store).length, 1);
  // Errors are never stored under the natural key (R20).
  assert.equal(rt.store.getReply(`accept:${OFFER_ID}:${B}:10271`), null);
});

test("two different accepts racing for one offer: one wins, the other gets offer_taken from the ledger", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  rt.store.insertOffer(outOfferRow);
  const [x, y] = await Promise.all([rt.process(acceptReq("m1")), rt.process(acceptReq("m2", { address: B, agentId: 10271 }, "ctx-other"))]);
  assert.equal(x.name, "status");
  assert.equal(y.name, "error");
  assert.equal(y.body.code, "offer_taken");
  assert.equal(y.taskState, "rejected");
  assert.deepEqual(y.actions, []);
  assert.equal(rt.store.getOffer(OFFER_ID).acceptedAddress, A);
  assert.equal(createJobs(rt.store).length, 1);
  assert.equal(rt.store.seenResponse("0xpeer", "m2").body.code, "offer_taken");
});

test("the same accept racing with itself is answered from the reply saved first", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  rt.store.insertOffer(outOfferRow);
  const [x, y] = await Promise.all([rt.process(acceptReq("m1")), rt.process(acceptReq("m2"))]);
  assert.equal(x.name, "status");
  assert.deepEqual(y.body, x.body);
  assert.deepEqual(y.actions, []);
  assert.equal(createJobs(rt.store).length, 1);
});

test("the same offerId with different terms gets idempotency_conflict", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  const first = await rt.process(offerReq("m1"));
  assert.equal(first.name, "status");
  assert.deepEqual(first.body.offer, { offerId: inboundBody.offerId, state: "under_review" });

  const r = await rt.process(offerReq("m2", { ...inboundBody, description: "something else" }));
  assert.equal(r.name, "error");
  assert.equal(r.body.code, "idempotency_conflict");
  assert.equal(r.body.field, "offerId");
  assert.equal(r.taskState, "rejected");
  assert.deepEqual(r.actions, []);

  const again = await rt.process(offerReq("m3"));
  assert.deepEqual(again.body, first.body);
  assert.deepEqual(rt.store.getReply(`offer:${inboundBody.offerId}`).response.body, first.body);
  assert.deepEqual(rt.store.listActions().map((x) => x.key), [`review_offer:${inboundBody.offerId}`]);
});

test("an inbound offer is stored with the request's contextId and the sender's address", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  const r = await rt.process(offerReq("m1"));
  assert.equal(r.taskState, "working");
  assert.equal(r.actions[0].contextId, "ctx-offer");
  const o = rt.store.getOffer(inboundBody.offerId);
  assert.equal(o.direction, "in");
  assert.equal(o.state, "under_review");
  assert.equal(o.contextId, "ctx-offer");
  assert.equal(o.peerAgentId, 10270);
  assert.equal(o.peerAddress, A);
  assert.equal(o.peerEndpoint, null);
});

test("errors are never saved under the natural key, and retryable ones are not remembered", async () => {
  const capped = { ...cfg, caps: { ...cfg.caps, maxOpenOffersPerAgent: 0 } };
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: capped, reader: chain(), clock });
  const busy = await rt.process(offerReq("m1"));
  assert.equal(busy.body.code, "capacity_exceeded");
  assert.equal(busy.body.retryable, true);
  assert.equal(rt.store.seenResponse("0xpeer", "m1"), null);
  assert.equal(rt.store.getReply(`offer:${inboundBody.offerId}`), null);

  const rt2 = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain({ allowedTokens: [] }), clock });
  const refused = await rt2.process(offerReq("m1"));
  assert.equal(refused.body.code, "unsupported_terms");
  assert.equal(rt2.store.seenResponse("0xpeer", "m1").body.code, "unsupported_terms");
  assert.equal(rt2.store.getReply(`offer:${inboundBody.offerId}`), null);
  assert.equal(rt2.store.getOffer(inboundBody.offerId), null);
});

test("chain unavailable: nothing is persisted and a retry succeeds", async () => {
  const reader = chain({ fail: true });
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader, clock });
  rt.store.insertOffer(linkedRow);
  assert.deepEqual(await rt.process(queryReq("m1")), { kind: "chain_unavailable" });
  assert.equal(rt.store.seenResponse("anon", "m1"), null);
  assert.equal(rt.store.getOffer(OFFER_ID).chainStatus, null);

  reader.setFail(false);
  const r = await rt.process(queryReq("m1"));
  assert.equal(r.kind, "ok");
  assert.equal(r.name, "status");
  assert.equal(r.body.job.jobId, "42");
  assert.equal(rt.store.getOffer(OFFER_ID).chainStatus, "Open");
  assert.notEqual(rt.store.seenResponse("anon", "m1"), null);
});

test("chain unavailable during an accept leaves the offer open and enqueues nothing", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain({ fail: true }), clock });
  rt.store.insertOffer(outOfferRow);
  assert.deepEqual(await rt.process(acceptReq("m1")), { kind: "chain_unavailable" });
  assert.equal(rt.store.getOffer(OFFER_ID).state, "open");
  assert.deepEqual(rt.store.listActions(), []);
  assert.equal(rt.store.getReply(`accept:${OFFER_ID}:${A}:10270`), null);
});

test("a hanging chain is reported as chain_unavailable", async () => {
  // The reader's own timeout (400 ms) is longer than the runtime's overall deadline (rpcTimeoutMs = 100).
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: { ...cfg, rpcTimeoutMs: 100 }, reader: chain({ hang: true, timeoutMs: 400 }), clock });
  rt.store.insertOffer(linkedRow);
  const t0 = Date.now();
  assert.deepEqual(await rt.process(queryReq("m1")), { kind: "chain_unavailable" });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 90 && elapsed < 350, `answered after ${elapsed} ms`);
  assert.equal(rt.store.seenResponse("anon", "m1"), null);
});

test("a query returns next with the simulation result", async () => {
  const sims = [];
  const reader = chain({ simulate: (tx) => { sims.push(tx); return { ok: false, reason: "WrongStatus" }; } });
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader, clock });
  rt.store.insertOffer(linkedRow);
  const r = await rt.process(queryReq("m1"));
  assert.equal(r.name, "status");
  assert.equal(r.taskState, "input-required");
  const n = r.body.next;
  assert.equal(n.actor, "provider");
  assert.equal(n.function, "setBudget(uint256,address,uint256,bytes)");
  assert.deepEqual(n.args, ["42", USDC, "250000", "0x"]);
  assert.match(n.data, /^0x[0-9a-f]+$/);
  assert.deepEqual(n.simulation, { ok: false, reason: "WrongStatus" });
  assert.deepEqual(sims, [{ account: A, to: cfg.escrow, data: n.data }]);
  assert.deepEqual(r.actions, []);

  const ok = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  ok.store.insertOffer(linkedRow);
  assert.deepEqual((await ok.process(queryReq("m1"))).body.next.simulation, { ok: true });
});

test("a query by offerId reads the linked job; a step without calldata is not simulated", async () => {
  const sims = [];
  const reader = chain({ jobs: { 42: job({ status: "Funded", budget: 250000n, paymentToken: USDC }) }, simulate: (tx) => { sims.push(tx); return { ok: true }; } });
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader, clock });
  rt.store.insertOffer(linkedRow);
  const r = await rt.process(queryReq("m1", { offerId: OFFER_ID }));
  assert.equal(r.body.job.chainStatus, "Funded");
  assert.equal(r.body.next.function, "submit(uint256,bytes32,bytes)");
  assert.equal(r.body.next.simulation, undefined);
  assert.deepEqual(sims, []);
});

test("a submitted notice on a Submitted job reads the deliverable and queues evaluate", async () => {
  const woken = [];
  const reader = chain({ jobs: { 42: job({ status: "Submitted", budget: 250000n, paymentToken: USDC, submittedAt: T - 10 }) }, deliverables: { 42: HASH } });
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader, clock, onAction: (row) => woken.push(row) });
  rt.store.insertOffer(linkedRow);
  const r = await rt.process(typed("submitted", { jobId: "42", deliverable: { hash: HASH, uri: "https://peer.example/out.json" } }, "m1"));
  assert.equal(r.name, "status");
  assert.equal(r.taskState, "working");
  assert.deepEqual(r.body.job.deliverable, { hash: HASH, uri: "https://peer.example/out.json", verified: true });
  assert.deepEqual(r.actions.map((a) => a.key), ["evaluate:42"]);
  assert.deepEqual(r.actions[0].payload, {
    jobId: "42", deadline: EXPIRES + 3600, urgent: false, deliverable: { hash: HASH, uri: "https://peer.example/out.json", verified: true },
  });
  // Job actions belong to the offer's task, where the peer polls.
  assert.equal(r.actions[0].contextId, OFFER_ID);
  assert.deepEqual(woken.map((w) => w.key), ["evaluate:42"]);
  const o = rt.store.getOffer(OFFER_ID);
  assert.equal(o.chainStatus, "Submitted");
  assert.deepEqual(o.deliverable, { hash: HASH, uri: "https://peer.example/out.json" });

  const again = await rt.process(typed("query", { jobId: "42" }, "m2"));
  assert.deepEqual(again.actions, [], "an action already queued is not new");
  assert.equal(woken.length, 1);
});

test("a legacy offer is normalized and goes to review", async () => {
  let now = T;
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock: () => now });
  const legacy = { intent: "offer", service: "hash-text", price: "0.25", asset: "USDC", terms: "Hash a text with keccak256." };
  const req = (messageId) => ({ detection: { kind: "legacy", body: legacy }, contextId: "ctx-legacy", sender: null, messageId });
  const r = await rt.process(req("m1"));
  assert.equal(r.name, "status");
  assert.equal(r.taskState, "working");
  const { offerId } = r.body.offer;
  assert.match(offerId, /^of_[A-Za-z0-9]{10}$/);
  assert.equal(r.body.offer.state, "under_review");
  assert.deepEqual(r.actions.map((a) => a.key), [`review_offer:${offerId}`]);
  const o = rt.store.getOffer(offerId);
  assert.equal(o.direction, "in");
  assert.equal(o.contextId, "ctx-legacy");
  assert.equal(o.terms.side, "provider");
  assert.equal(o.terms.description, "Hash a text with keccak256.");
  assert.deepEqual(o.terms.price, price);
  assert.equal(o.expiresAt, T + cfg.minOfferTtlSeconds);

  // The same legacy body later maps to the same offerId (R12) and replays, although its default expiry would move.
  now += 600;
  const again = await rt.process(req("m2"));
  assert.deepEqual(again.body, r.body);
  assert.deepEqual(rt.store.listActions().map((a) => a.key), [`review_offer:${offerId}`]);

  // A legacy body that cannot be normalized is invalid.
  const bad = await rt.process({ detection: { kind: "legacy", body: { ...legacy, price: "0.0000001" } }, contextId: "c", sender: null, messageId: "m3" });
  assert.equal(bad.kind, "invalid");
  assert.equal(bad.field, "price");
});

test("status and error from peers are only logged", async () => {
  const logs = [];
  const db = new Database(":memory:");
  const reader = chain();
  const rt = createJobsRuntime({ db, config: cfg, reader, clock, log: (...args) => logs.push(args) });
  const received = { kind: "ok", name: null, body: null, text: "Received.", taskState: "completed", actions: [] };
  assert.deepEqual(await rt.process(typed("status", { next: { actor: null } }, "m1")), received);
  assert.deepEqual(await rt.process(typed("error", { code: "offer_taken" }, "m2")), received);
  assert.equal(logs.length, 2);
  assert.match(logs[0][0], /status/);
  assert.equal(reader.calls, 0);
  assert.equal(rt.store.seenResponse("0xpeer", "m1"), null);
  assert.deepEqual(rt.store.listActions(), []);

  // An existing task keeps its state (R28).
  db.exec(`CREATE TABLE tasks (context_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO tasks VALUES (?,?,?,?)`).run("ctx-peer", "input-required", 1, 1);
  assert.equal((await rt.process(typed("status", {}, "m3"))).taskState, "input-required");
  assert.equal((await rt.process(typed("status", {}, "m4", { contextId: "ctx-new" }))).taskState, "completed");
});

test("a duplicate messageId returns the remembered response", async () => {
  const reader = chain();
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader, clock });
  rt.store.insertOffer(linkedRow);
  const first = await rt.process(queryReq("m1"));
  const calls = reader.calls;
  reader.setFail(true);
  assert.deepEqual(await rt.process(queryReq("m1")), first);
  assert.equal(reader.calls, calls);
  // A null sender is remembered as "anon" (R11).
  assert.deepEqual(rt.store.seenResponse("anon", "m1"), first);
});

test("invalid bodies and unsupported names", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  assert.deepEqual(await rt.process({ detection: { kind: "invalid", field: "data", detail: "two keys" }, contextId: "c", sender: null, messageId: "m1" }),
    { kind: "invalid", field: "data", detail: "two keys" });
  const bad = await rt.process(acceptReq("m2", { address: "0x123", agentId: 10270 }));
  assert.equal(bad.kind, "invalid");
  assert.equal(bad.field, "party.address");
  assert.equal(rt.store.seenResponse("0xpeer", "m2"), null);

  const r = await rt.process(typed("bid", { offerId: OFFER_ID }, "m3"));
  assert.equal(r.kind, "ok");
  assert.equal(r.name, "error");
  assert.equal(r.body.code, "unsupported_key");
  assert.equal(r.body.field, "defigent.job.bid");
  assert.equal(r.body.retryable, false);
  assert.equal(r.taskState, "rejected");
  assert.deepEqual(rt.store.seenResponse("0xpeer", "m3"), r);
});

test("recordOperatorClaim takes only claim names and dedupes by replyId", () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  const created = { "defigent.job.created": { jobId: "42", offerId: OFFER_ID } };
  assert.equal(rt.recordOperatorClaim({ contextId: OFFER_ID, replyId: `create_job:${OFFER_ID}`, data: created }), true);
  assert.equal(rt.recordOperatorClaim({ contextId: OFFER_ID, replyId: `create_job:${OFFER_ID}`, data: created }), true);
  assert.equal(rt.store.pendingClaims(10).length, 1);

  const verdict = { "defigent.job.accept": { offerId: "of_InBound123", party: { address: A.toLowerCase(), agentId: 10270 } } };
  assert.equal(rt.recordOperatorClaim({ contextId: "ctx-offer", replyId: "review_offer:of_InBound123", data: verdict }), true);
  for (const data of [
    { "defigent.job.status": { next: {} } },
    { "defigent.job.submitted": { jobId: "42", deliverable: { hash: HASH } } },
    { "defigent.job.query": { jobId: "42" } },
    { "defigent.job.funded": { jobId: "0" } },
    { "defigent.job.funded": { jobId: "42" }, "defigent.job.completed": { jobId: "42" } },
    { note: "no typed key" },
    {},
  ]) assert.equal(rt.recordOperatorClaim({ contextId: OFFER_ID, replyId: "x", data }), false, JSON.stringify(data));

  const claims = rt.store.pendingClaims(10);
  assert.deepEqual(claims.map((c) => [c.contextId, c.replyId, c.name]), [
    [OFFER_ID, `create_job:${OFFER_ID}`, "created"],
    ["ctx-offer", "review_offer:of_InBound123", "accept"],
  ]);
  // The body is stored as parsed, with the address checksummed.
  assert.deepEqual(claims[1].body, { offerId: "of_InBound123", party: { address: A, agentId: 10270 } });
});

test("adaptText turns 'of_… 0x…' into an accept for our open offer", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  rt.store.insertOffer(outOfferRow);
  const adapted = rt.adaptText(`Sure, ${OFFER_ID} pay ${A.toLowerCase()}`);
  assert.deepEqual(adapted, { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 10270 } } });
  assert.equal(rt.adaptText(`of_ZzZzZz9999 ${A}`), null);
  assert.equal(rt.adaptText("hello"), null);
  const r = await rt.process({ detection: { kind: "typed", ...adapted }, contextId: "ctx-text", sender: null, messageId: "m1" });
  assert.deepEqual(r.body.offer, { offerId: OFFER_ID, state: "accepted" });
});

test("detect and jsonSchema come from the protocol module", () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: chain(), clock });
  assert.deepEqual(rt.detect([{ "defigent.job.query": { jobId: "42" } }]), { kind: "typed", name: "query", body: { jobId: "42" } });
  assert.deepEqual(rt.detect([{ text: "hi" }]), { kind: "none" });
  assert.ok(Array.isArray(rt.jsonSchema().anyOf));
});
