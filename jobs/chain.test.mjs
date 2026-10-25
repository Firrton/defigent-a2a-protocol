import { test } from "node:test";
import assert from "node:assert/strict";
import {
  custom, decodeFunctionData, getAddress, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult,
  numberToHex, pad, parseAbi, toHex, zeroAddress, zeroHash,
} from "viem";
import { ESCROW_ABI, IDENTITY_ABI } from "./abi.mjs";
import { loadJobsConfig } from "./config.mjs";
import { ChainUnavailable, createChainReader } from "./chain.mjs";
import { createFakeChain } from "./fake_chain.mjs";

const cfg = loadJobsConfig({ env: {} });
const USDC = cfg.tokens.USDC.address;
const PEER = getAddress("0xabc0000000000000000000000000000000000001");
const OWNER = getAddress("0x00000000000000000000000000000000000000a1");
const WALLET = getAddress("0x00000000000000000000000000000000000000b2");
const HASH = "0x" + "ab".repeat(32);
const ABI = [...ESCROW_ABI, ...IDENTITY_ABI];
const ERRORS = parseAbi(["error ERC721NonexistentToken(uint256 tokenId)", "error WrongStatus()"]);

const revert = (data) => Object.assign(new Error("execution reverted"), { code: 3, data });
const result = (functionName, value) => encodeFunctionResult({ abi: ABI, functionName, result: value });

const STRUCT = {
  client: cfg.client, status: 1, provider: PEER, expiredAt: 1792086400, evaluator: cfg.evaluator, submittedAt: 0, budget: 250000n, hook: cfg.hook,
  paymentToken: USDC, providerAgentId: 10270n, description: '{"offerId":"of_AbCdEf1234","terms":"0x01","v":1}', settledAmount: 0n, payoutReceiver: PEER,
};
const EMPTY = {
  client: zeroAddress, status: 0, provider: zeroAddress, expiredAt: 0, evaluator: zeroAddress, submittedAt: 0, budget: 0n, hook: zeroAddress,
  paymentToken: zeroAddress, providerAgentId: 0n, description: "", settledAmount: 0n, payoutReceiver: zeroAddress,
};

// A JSON-RPC node for the escrow and identity views. `onCall` may override any eth_call; `log` records every request.
function node({ onCall, latest = 100000n, logs = () => [], log = [] } = {}) {
  return custom({
    async request({ method, params }) {
      log.push({ method, params });
      if (method === "eth_blockNumber") return numberToHex(latest);
      if (method === "eth_getBlockByNumber") return { number: numberToHex(latest), timestamp: numberToHex(1792000123), hash: HASH, transactions: [] };
      if (method === "eth_getLogs") return logs(params[0]);
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const overridden = onCall?.(params[0]);
      if (overridden !== undefined) return overridden;
      const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data });
      if (functionName === "getJob") return result("getJob", args[0] === 7n ? STRUCT : EMPTY);
      if (functionName === "allowedPaymentTokens") return result("allowedPaymentTokens", args[0].toLowerCase() === USDC.toLowerCase());
      if (functionName === "pendingClaimHash") return result("pendingClaimHash", args[0] === 7n ? HASH : zeroHash);
      if (functionName === "ownerOf") {
        if (args[0] === 10270n) return result("ownerOf", OWNER);
        throw revert(encodeErrorResult({ abi: ERRORS, errorName: "ERC721NonexistentToken", args: [args[0]] }));
      }
      if (functionName === "getAgentWallet") return result("getAgentWallet", WALLET);
      throw new Error(`unexpected ${functionName}`);
    },
  }, { retryCount: 0 });
}

const reader = (transport, timeoutMs = 1000) => createChainReader({ config: cfg, rpcUrl: "http://unused", timeoutMs, transport });

test("getJob maps the struct and returns null for an empty slot", async () => {
  const r = reader(node());
  assert.deepEqual(await r.getJob(7n), {
    jobId: 7n, client: cfg.client, status: "Funded", provider: PEER, expiredAt: 1792086400, evaluator: cfg.evaluator, submittedAt: 0, budget: 250000n,
    hook: cfg.hook, paymentToken: USDC, providerAgentId: 10270n, description: STRUCT.description, settledAmount: 0n, payoutReceiver: PEER,
  });
  assert.equal(await r.getJob(1n), null);
});

test("isBoundToAgent: owner match, wallet match, neither, and ownerOf revert", async () => {
  const r = reader(node());
  assert.equal(await r.isBoundToAgent(OWNER.toLowerCase(), 10270n), true);
  assert.equal(await r.isBoundToAgent(WALLET, 10270n), true);
  assert.equal(await r.isBoundToAgent(PEER, 10270n), false);
  assert.equal(await r.isBoundToAgent(OWNER, 999n), false);

  const walletReverts = reader(node({
    onCall: ({ data }) => (decodeFunctionData({ abi: ABI, data }).functionName === "getAgentWallet" ? (() => { throw revert("0x"); })() : undefined),
  }));
  assert.equal(await walletReverts.isBoundToAgent(PEER, 10270n), false);
  assert.equal(await walletReverts.isBoundToAgent(OWNER, 10270n), true);
});

test("a hanging transport raises ChainUnavailable within the timeout", async () => {
  const r = createChainReader({ config: cfg, rpcUrl: "http://unused", timeoutMs: 200, transport: custom({ request: () => new Promise(() => {}) }) });
  const t0 = Date.now();
  await assert.rejects(r.getJob(1n), ChainUnavailable);
  assert.ok(Date.now() - t0 < 1000);
  for (const call of [() => r.isBoundToAgent(OWNER, 10270n), () => r.blockTime(), () => r.simulate({ account: PEER, to: cfg.escrow, data: "0x" })])
    await assert.rejects(call(), ChainUnavailable);
});

test("a transport error raises ChainUnavailable", async () => {
  const r = reader(custom({ request: async () => { throw new Error("connect ECONNREFUSED"); } }, { retryCount: 0 }));
  await assert.rejects(r.getJob(1n), (e) => e instanceof ChainUnavailable && e.name === "ChainUnavailable" && /ECONNREFUSED/.test(e.cause?.message ?? e.message));
  // A failing node is not a revert: binding checks and simulations must not turn it into false or { ok: false }.
  await assert.rejects(r.isBoundToAgent(OWNER, 10270n), ChainUnavailable);
  await assert.rejects(r.isAllowedToken(USDC), ChainUnavailable);
  await assert.rejects(r.simulate({ account: PEER, to: cfg.escrow, data: "0x" }), ChainUnavailable);
});

test("simulate returns the revert reason", async () => {
  const setBudget = encodeFunctionData({ abi: ESCROW_ABI, functionName: "setBudget", args: [42n, USDC, 250000n, "0x"] });
  const calls = [];
  const r = reader(node({
    onCall: (tx) => {
      calls.push(tx);
      if (tx.from.toLowerCase() === PEER.toLowerCase()) return "0x";
      if (tx.from.toLowerCase() === OWNER.toLowerCase()) throw revert(encodeErrorResult({ abi: ERRORS, errorName: "WrongStatus" }));
      throw revert(encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["not allowed"] }));
    },
  }));
  assert.deepEqual(await r.simulate({ account: PEER, to: cfg.escrow, data: setBudget }), { ok: true });
  assert.deepEqual(await r.simulate({ account: OWNER, to: cfg.escrow, data: setBudget }), { ok: false, reason: "WrongStatus" });
  assert.deepEqual(await r.simulate({ account: WALLET, to: cfg.escrow, data: setBudget, value: 5n }), { ok: false, reason: "not allowed" });
  assert.equal(calls[0].to.toLowerCase(), cfg.escrow.toLowerCase());
  assert.equal(calls[0].data, setBudget);
  assert.equal(calls[2].value, "0x5");
});

test("escrow views: allowed token, pending claim and block time", async () => {
  const r = reader(node());
  assert.equal(await r.isAllowedToken(USDC), true);
  assert.equal(await r.isAllowedToken(PEER), false);
  assert.equal(await r.hasPendingClaim(7n), true);
  assert.equal(await r.hasPendingClaim(8n), false);
  assert.equal(await r.blockTime(), 1792000123);
});

test("submittedDeliverable reads JobSubmitted for the job over the last 50000 blocks", async () => {
  const event = ESCROW_ABI.find((x) => x.type === "event" && x.name === "JobSubmitted");
  const submitted = (jobId, deliverable) => ({
    address: cfg.escrow.toLowerCase(), topics: encodeEventTopics({ abi: [event], eventName: "JobSubmitted", args: { jobId, provider: PEER } }),
    data: encodeAbiParameters([{ type: "bytes32" }], [deliverable]), blockNumber: "0x10", blockHash: HASH, transactionHash: HASH,
    transactionIndex: "0x0", logIndex: "0x0", removed: false,
  });
  const log = [];
  const r = reader(node({ log, latest: 120000n, logs: (filter) => (filter.topics[1] === pad(toHex(42n)) ? [submitted(42n, HASH)] : []) }));
  assert.equal(await r.submittedDeliverable(42n), HASH);
  assert.equal(await r.submittedDeliverable(43n), null);
  const filter = log.find((x) => x.method === "eth_getLogs").params[0];
  assert.equal(filter.address.toLowerCase(), cfg.escrow.toLowerCase());
  assert.equal(filter.fromBlock, numberToHex(70000n));
  assert.equal(filter.toBlock, numberToHex(120000n));

  const young = [];
  await reader(node({ log: young, latest: 1200n })).submittedDeliverable(42n);
  assert.equal(young.find((x) => x.method === "eth_getLogs").params[0].fromBlock, "0x0");

  const capped = reader(node({ logs: () => { throw Object.assign(new Error("block range too large, max 1000"), { code: -32005 }); } }));
  assert.equal(await capped.submittedDeliverable(42n), null);
  const broken = reader(node({ logs: () => { throw new Error("connect ECONNREFUSED"); } }));
  await assert.rejects(broken.submittedDeliverable(42n), ChainUnavailable);
});

test("the fake chain serves its fixtures, counts calls and fails or hangs on demand", async () => {
  const job = { ...STRUCT, jobId: 7n, status: "Funded" };
  const fake = createFakeChain({
    jobs: { 7: job }, bindings: [{ address: OWNER, agentId: 10270 }], allowedTokens: [USDC], pendingClaims: [7n], deliverables: { 7: HASH },
    simulate: ({ account }) => (account === PEER ? { ok: true } : { ok: false, reason: "Unauthorized" }),
  });
  assert.deepEqual(await fake.getJob(7n), job);
  assert.equal(await fake.getJob(8n), null);
  assert.equal(await fake.isBoundToAgent(OWNER.toLowerCase(), 10270n), true);
  assert.equal(await fake.isBoundToAgent(OWNER, 10271n), false);
  assert.equal(await fake.isAllowedToken(USDC.toLowerCase()), true);
  assert.equal(await fake.isAllowedToken(PEER), false);
  assert.equal(await fake.hasPendingClaim(7n), true);
  assert.equal(await fake.hasPendingClaim(8n), false);
  assert.equal(await fake.submittedDeliverable(7n), HASH);
  assert.equal(await fake.submittedDeliverable(8n), null);
  assert.equal(await fake.blockTime(), 1792000000);
  assert.deepEqual(await fake.simulate({ account: PEER, to: cfg.escrow, data: "0x" }), { ok: true });
  assert.deepEqual(await fake.simulate({ account: OWNER, to: cfg.escrow, data: "0x" }), { ok: false, reason: "Unauthorized" });
  assert.deepEqual(await createFakeChain().simulate({ account: PEER, to: cfg.escrow, data: "0x" }), { ok: true });
  assert.equal(fake.calls, 13);

  const t0 = Date.now();
  await assert.rejects(createFakeChain({ fail: true }).getJob(7n), ChainUnavailable);
  assert.ok(Date.now() - t0 < 40);
  const hanging = createFakeChain({ hang: true, timeoutMs: 60 });
  const t1 = Date.now();
  await assert.rejects(hanging.blockTime(), ChainUnavailable);
  assert.ok(Date.now() - t1 >= 55);
  assert.equal(hanging.calls, 1);

  fake.setFail(true);
  await assert.rejects(fake.getJob(7n), ChainUnavailable);
  fake.setFail(false);
  assert.deepEqual(await fake.getJob(7n), job);
  hanging.setHang(false);
  assert.equal(await hanging.blockTime(), 1792000000);
});
