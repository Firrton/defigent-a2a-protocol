import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import { loadJobsConfig, tokenByAddress, tokenBySymbol } from "./config.mjs";

const DEFAULT_FILE = new URL("../data/jobs-config.json", import.meta.url);

function tmpConfig(overrides) {
  const base = JSON.parse(fs.readFileSync(DEFAULT_FILE, "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-config-"));
  const file = path.join(dir, "jobs-config.json");
  fs.writeFileSync(file, JSON.stringify({ ...base, ...overrides }));
  return file;
}

test("loads data/jobs-config.json with checksummed addresses and bigint caps", () => {
  const c = loadJobsConfig({ env: {} });
  assert.equal(c.chainId, 143);
  assert.equal(c.agentId, 10331);
  assert.equal(c.escrow, "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65");
  assert.equal(c.hook, getAddress("0x03d516e52fd64e2d19a817498f941d7dea452cd6"));
  assert.equal(c.caps.maxOfferAmount, 1000000n);
  assert.equal(c.caps.maxOpenOffersPerAgent, 2);
  assert.equal(c.caps.maxCreateJobPerDay, 10);
  assert.equal(c.minOfferTtlSeconds, 86400);
  assert.equal(c.minWorkWindowSeconds, 3600);
  assert.equal(c.rpcTimeoutMs, 3000);
  assert.equal(c.sweepMs, 60000);
  assert.deepEqual(c.tokens.USDC, { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 });
  assert.equal(c.inboxUrl, "https://defigent.app/inbox");
  assert.equal(c.schemaUrl, "https://defigent.app/schemas/erc8183-jobs-v1.json");
});

test("env overrides sweep interval, rpc timeout and hook", () => {
  const c = loadJobsConfig({ env: { DEFIGENT_JOBS_SWEEP_MS: "200", DEFIGENT_JOBS_RPC_TIMEOUT_MS: "500", DEFIGENT_JOBS_HOOK: "0x000000000000000000000000000000000000dead" } });
  assert.deepEqual([c.sweepMs, c.rpcTimeoutMs, c.hook], [200, 500, "0x000000000000000000000000000000000000dEaD"]);
});

test("a sweep interval under 50 ms is rejected", () =>
  assert.throws(() => loadJobsConfig({ env: { DEFIGENT_JOBS_SWEEP_MS: "10" } }), /DEFIGENT_JOBS_SWEEP_MS/));

test("an rpc timeout under 100 ms is rejected", () =>
  assert.throws(() => loadJobsConfig({ env: { DEFIGENT_JOBS_RPC_TIMEOUT_MS: "99" } }), /DEFIGENT_JOBS_RPC_TIMEOUT_MS/));

test("a malformed hook override names the variable", () =>
  assert.throws(() => loadJobsConfig({ env: { DEFIGENT_JOBS_HOOK: "0xnope" } }), /DEFIGENT_JOBS_HOOK/));

test("a malformed escrow address names the field", () =>
  assert.throws(() => loadJobsConfig({ file: tmpConfig({ escrow: "0x123" }), env: {} }), /jobs-config: escrow/));

test("a non-integer maxOfferAmount names the field", () =>
  assert.throws(() => loadJobsConfig({ file: tmpConfig({ caps: { maxOfferAmount: "2.5", maxOpenOffersPerAgent: 2, maxCreateJobPerDay: 10 } }), env: {} }), /caps\.maxOfferAmount/));

test("tokenByAddress ignores case", () =>
  assert.equal(tokenByAddress(loadJobsConfig({ env: {} }), "0x754704bc059f8c67012fed69bc8a327a5aafb603").symbol, "USDC"));

test("token lookups return { symbol, address, decimals } or null", () => {
  const c = loadJobsConfig({ env: {} });
  const usdc = { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 };
  assert.deepEqual(tokenBySymbol(c, "USDC"), usdc);
  assert.deepEqual(tokenByAddress(c, usdc.address), usdc);
  assert.equal(tokenBySymbol(c, "DAI"), null);
  assert.equal(tokenByAddress(c, "0x000000000000000000000000000000000000dEaD"), null);
  assert.equal(tokenByAddress(c, "not-an-address"), null);
});
