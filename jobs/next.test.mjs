import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { ESCROW_ABI } from "./abi.mjs";
import { loadJobsConfig } from "./config.mjs";
import { nextStep, offerNext, taskStateFor } from "./next.mjs";

const cfg = loadJobsConfig({ env: {} });
const USDC = cfg.tokens.USDC.address;
const PEER = "0xAbC0000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000Bad";
const T = 1792000000;
const EXPIRED_AT = T + 86400;
const OFFER_ID = "of_AbCdEf1234";

const job = (overrides) => ({
  jobId: 42n, client: cfg.client, status: "Open", provider: PEER, expiredAt: EXPIRED_AT, evaluator: cfg.evaluator, submittedAt: 0,
  budget: 0n, hook: cfg.hook, paymentToken: zeroAddress, providerAgentId: 10270n, description: "", settledAmount: 0n, payoutReceiver: zeroAddress,
  ...overrides,
});

const terms = {
  offerId: OFFER_ID, side: "client", service: "hash-text", description: "keccak256 of a text",
  price: { amount: "250000", token: USDC, decimals: 6, symbol: "USDC" },
  settlement: { chainId: 143, escrow: cfg.escrow }, deliverable: { mediaType: "text/plain", acceptance: "operator" }, expiresAt: EXPIRED_AT,
};
const offerRow = (overrides) => ({ offerId: OFFER_ID, direction: "out", state: "accepted", terms, expiresAt: EXPIRED_AT, jobId: "42", ...overrides });
const offer = offerRow();
const pick = (n) => ({ actor: n.actor, ours: n.ours, action: n.action });

test("Open without budget: the provider calls setBudget with the agreed amount", () => {
  const n = nextStep({ job: job({ status: "Open", budget: 0n }), offer, now: T, config: cfg });
  assert.equal(n.actor, "provider");
  assert.equal(n.ours, false);
  assert.equal(n.action, undefined);
  assert.equal(n.to, cfg.escrow);
  assert.equal(n.function, "setBudget(uint256,address,uint256,bytes)");
  assert.deepEqual(n.args, ["42", USDC, "250000", "0x"]);
  assert.equal(n.data, encodeFunctionData({ abi: ESCROW_ABI, functionName: "setBudget", args: [42n, USDC, 250000n, "0x"] }));
  assert.equal(n.mismatch, undefined);
  assert.equal(n.call, undefined);
  assert.equal(typeof n.note, "string");
});

test("Open without an offer on record: setBudget carries no amount, token or data, and nothing gets funded", () => {
  const n = nextStep({ job: job({ status: "Open", budget: 0n }), offer: null, now: T, config: cfg });
  assert.equal(n.actor, "provider");
  assert.equal(n.function, "setBudget(uint256,address,uint256,bytes)");
  assert.deepEqual(n.args, ["42", null, null, "0x"]);
  assert.equal(n.data, undefined);
  assert.equal(n.mismatch, undefined);

  const funded = nextStep({ job: job({ status: "Open", budget: 250000n, paymentToken: USDC }), offer: null, now: T, config: cfg });
  assert.deepEqual(pick(funded), { actor: "client", ours: true, action: undefined });
  assert.equal(funded.mismatch, undefined);
  assert.equal(funded.data, undefined);
});

test("Open with a different budget flags a mismatch", () => {
  const expected = encodeFunctionData({ abi: ESCROW_ABI, functionName: "setBudget", args: [42n, USDC, 250000n, "0x"] });
  for (const [budget, paymentToken] of [[100000n, USDC], [250000n, OTHER], [250000n, zeroAddress]]) {
    const n = nextStep({ job: job({ status: "Open", budget, paymentToken }), offer, now: T, config: cfg });
    assert.equal(n.actor, "provider");
    assert.equal(n.ours, false);
    assert.equal(n.mismatch, true);
    assert.deepEqual(n.args, ["42", USDC, "250000", "0x"]);
    assert.equal(n.data, expected);
    assert.equal(n.action, undefined);
  }
});

test("Open with the agreed budget: we fund", () => {
  assert.deepEqual(pick(nextStep({ job: job({ status: "Open", budget: 250000n, paymentToken: USDC }), offer, now: T, config: cfg })),
    { actor: "client", ours: true, action: "fund" });
  // The token comparison ignores the address case.
  const n = nextStep({ job: job({ status: "Open", budget: 250000n, paymentToken: USDC.toLowerCase() }), offer, now: T, config: cfg });
  assert.deepEqual(pick(n), { actor: "client", ours: true, action: "fund" });
  assert.equal(n.mismatch, undefined);
});

test("Funded: the provider submits", () => {
  const n = nextStep({ job: job({ status: "Funded", budget: 250000n, paymentToken: USDC }), offer, now: T, config: cfg });
  assert.deepEqual(pick(n), { actor: "provider", ours: false, action: undefined });
  assert.equal(n.to, cfg.escrow);
  assert.equal(n.function, "submit(uint256,bytes32,bytes)");
  // No args: the deliverable hash is the provider's, and args only ever carry real values (extension spec §4).
  assert.equal(n.args, undefined);
  assert.equal(n.data, undefined);
  assert.match(n.note, /submit\(42, <keccak256 of the deliverable>, 0x\)/);
});

test("Submitted: evaluate before expiredAt + 3600, urgent in the last 6 h", () => {
  const deadline = EXPIRED_AT + 3600;
  const at = (now) => nextStep({ job: job({ status: "Submitted", budget: 250000n, paymentToken: USDC, submittedAt: T }), offer, now, config: cfg });
  const early = at(deadline - 21601);
  assert.deepEqual(pick(early), { actor: "evaluator", ours: true, action: "evaluate" });
  assert.equal(early.deadline, deadline);
  assert.equal(early.urgent, false);
  assert.equal(at(deadline - 21600).urgent, true);
  const late = at(deadline + 10);
  assert.deepEqual(pick(late), { actor: "evaluator", ours: true, action: "evaluate" });
  assert.equal(late.deadline, deadline);
  assert.equal(late.urgent, true);
});

test("Funded past expiry with a pending claim: no refund", () => {
  for (const status of ["Funded", "Open"]) {
    const n = nextStep({ job: job({ status, budget: 250000n, paymentToken: USDC }), offer, now: EXPIRED_AT, config: cfg, pendingClaim: true });
    assert.deepEqual(pick(n), { actor: null, ours: false, action: undefined }, status);
  }
});

test("Funded past expiry without a pending claim: refund", () => {
  for (const status of ["Funded", "Open"]) {
    for (const now of [EXPIRED_AT, EXPIRED_AT + 1]) {
      const n = nextStep({ job: job({ status, budget: 250000n, paymentToken: USDC }), offer, now, config: cfg, pendingClaim: false });
      assert.deepEqual(pick(n), { actor: "anyone", ours: true, action: "refund" }, `${status} at ${now}`);
    }
  }
  // An Open job that never got a budget refunds too once it is past expiry (claimRefund accepts Open).
  assert.deepEqual(pick(nextStep({ job: job({ status: "Open", budget: 0n }), offer: null, now: EXPIRED_AT, config: cfg })),
    { actor: "anyone", ours: true, action: "refund" });
  // One second before expiry nothing is refundable yet.
  assert.deepEqual(pick(nextStep({ job: job({ status: "Funded", budget: 250000n, paymentToken: USDC }), offer, now: EXPIRED_AT - 1, config: cfg })),
    { actor: "provider", ours: false, action: undefined });
});

test("terminal states have no actor and map to completed or failed", () => {
  for (const [status, state] of [["Completed", "completed"], ["Rejected", "failed"], ["Expired", "failed"]]) {
    const j = job({ status, budget: 250000n, paymentToken: USDC });
    const n = nextStep({ job: j, offer, now: T, config: cfg });
    assert.deepEqual(pick(n), { actor: null, ours: false, action: undefined }, status);
    assert.equal(n.function, undefined);
    assert.equal(taskStateFor({ next: n, job: j, offer }), state, status);
  }
  const fund = job({ status: "Open", budget: 250000n, paymentToken: USDC });
  assert.equal(taskStateFor({ next: nextStep({ job: fund, offer, now: T, config: cfg }), job: fund, offer }), "working");
  const submit = job({ status: "Funded", budget: 250000n, paymentToken: USDC });
  assert.equal(taskStateFor({ next: nextStep({ job: submit, offer, now: T, config: cfg }), job: submit, offer }), "input-required");
});

test("taskStateFor follows the offer state when there is no job", () => {
  const declinedByThem = offerRow({ direction: "out", state: "declined", jobId: null });
  assert.equal(taskStateFor({ next: offerNext(declinedByThem, T), job: null, offer: declinedByThem }), "completed");
  const declinedByUs = offerRow({ direction: "in", state: "declined", jobId: null, terms: { ...terms, side: "provider" } });
  assert.equal(taskStateFor({ next: offerNext(declinedByUs, T), job: null, offer: declinedByUs }), "rejected");
  const expired = offerRow({ state: "expired", jobId: null });
  assert.equal(taskStateFor({ next: offerNext(expired, T), job: null, offer: expired }), "failed");
  const lapsed = offerRow({ state: "open", jobId: null });
  assert.equal(taskStateFor({ next: offerNext(lapsed, EXPIRED_AT), job: null, offer: lapsed }), "failed");
  const waiting = offerRow({ state: "open", jobId: null });
  assert.equal(taskStateFor({ next: offerNext(waiting, T), job: null, offer: waiting }), "input-required");
  const toCreate = offerRow({ state: "accepted", jobId: null });
  assert.equal(taskStateFor({ next: offerNext(toCreate, T), job: null, offer: toCreate }), "working");
  assert.equal(taskStateFor({ next: offerNext(toCreate, EXPIRED_AT), job: null, offer: toCreate }), "failed");
  // An accepted offer whose job is recorded but not loaded is not a lapsed offer.
  const built = offerRow({ state: "accepted", jobId: "42" });
  assert.equal(taskStateFor({ next: offerNext(built, EXPIRED_AT), job: null, offer: built }), "input-required");
});

test("offerNext covers open, under_review, accepted and declined", () => {
  assert.deepEqual(pick(offerNext(offerRow({ direction: "out", state: "open", jobId: null }), T)), { actor: "provider", ours: false, action: undefined });
  const inbound = offerRow({ direction: "in", state: "under_review", jobId: null, terms: { ...terms, side: "provider" } });
  assert.deepEqual(pick(offerNext(inbound, T)), { actor: "client", ours: true, action: undefined });
  assert.deepEqual(pick(offerNext(offerRow({ state: "accepted", jobId: null }), T)), { actor: "client", ours: true, action: "create_job" });
  assert.deepEqual(pick(offerNext(offerRow({ state: "declined", jobId: null }), T)), { actor: null, ours: false, action: undefined });
  assert.deepEqual(pick(offerNext(offerRow({ state: "expired", jobId: null }), T)), { actor: null, ours: false, action: undefined });
  // Open or under review past expiresAt: nobody acts any more.
  assert.deepEqual(pick(offerNext(offerRow({ direction: "out", state: "open", jobId: null }), EXPIRED_AT)), { actor: null, ours: false, action: undefined });
  assert.deepEqual(pick(offerNext(inbound, EXPIRED_AT)), { actor: null, ours: false, action: undefined });
  // Accepted but the job was never created before expiresAt: create_job would revert, nobody acts.
  const unbuilt = offerRow({ state: "accepted", jobId: null });
  assert.deepEqual(pick(offerNext(unbuilt, EXPIRED_AT - 1)), { actor: "client", ours: true, action: "create_job" });
  assert.deepEqual(pick(offerNext(unbuilt, EXPIRED_AT)), { actor: null, ours: false, action: undefined });
  assert.deepEqual(pick(offerNext(unbuilt, EXPIRED_AT + 86400)), { actor: null, ours: false, action: undefined });
  // With a job on record the chain decides, whatever the clock says.
  assert.equal(offerNext(offerRow({ state: "accepted", jobId: "42" }), EXPIRED_AT + 86400).note, "Job 42 exists; its on-chain state decides the next step.");
  for (const state of ["open", "under_review", "accepted", "declined", "expired"]) assert.equal(typeof offerNext(offerRow({ state, jobId: null }), T).note, "string");
});

test("jobs whose client is not us never get ours: true", () => {
  const theirs = { client: OTHER, evaluator: OTHER };
  for (const status of ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"]) {
    for (const budget of [0n, 100000n, 250000n]) {
      for (const now of [T, EXPIRED_AT, EXPIRED_AT + 7200]) {
        for (const pendingClaim of [false, true]) {
          const n = nextStep({ job: job({ ...theirs, status, budget, paymentToken: USDC }), offer, now, config: cfg, pendingClaim });
          assert.equal(n.ours, false, `${status} budget ${budget} at ${now} pending ${pendingClaim}`);
        }
      }
    }
  }
  // Funding is still the client's step, just not ours; evaluate needs us as the evaluator, not only as the client.
  assert.deepEqual(pick(nextStep({ job: job({ ...theirs, status: "Open", budget: 250000n, paymentToken: USDC }), offer, now: T, config: cfg })),
    { actor: "client", ours: false, action: "fund" });
  assert.deepEqual(pick(nextStep({ job: job({ evaluator: OTHER, status: "Submitted" }), offer, now: T, config: cfg })),
    { actor: "evaluator", ours: false, action: "evaluate" });
  assert.deepEqual(pick(nextStep({ job: job({ client: OTHER, status: "Funded" }), offer, now: EXPIRED_AT, config: cfg })),
    { actor: "anyone", ours: false, action: "refund" });
});

test("Submitted: a job that names Defigent as evaluator but has another client is not ours (roles in v1)", () => {
  const n = nextStep({ job: job({ status: "Submitted", client: getAddress("0x3333333333333333333333333333333333333333"), budget: 250000n, paymentToken: USDC }), offer: null, now: T, config: cfg });
  assert.deepEqual(pick(n), { actor: "evaluator", ours: false, action: "evaluate" });
});
