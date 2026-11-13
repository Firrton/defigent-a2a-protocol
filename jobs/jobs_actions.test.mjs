// scripts/jobs_actions.mjs as a subprocess: the data-directory requirement, the atomic claim and the guards that stop a
// send before any key or chain is touched. No test here reaches a network: RPC_URL points at a closed local port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadJobsConfig } from "./config.mjs";
import { createJobsStore, migrateJobsStore } from "./store.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/jobs_actions.mjs", import.meta.url));
const cfg = loadJobsConfig({ env: {} });
const USDC = cfg.tokens.USDC.address;
const OFFER_ID = "of_InBound123";
const NOT_OUR_KEY = `0x${"01".repeat(32)}`;

function run(args, { dataDir, env = {} } = {}) {
  const base = { ...process.env, RPC_URL: "http://127.0.0.1:9" };
  delete base.DEFIGENT_PRIVATE_KEY;
  delete base.DEFIGENT_DATA_DIR;
  if (dataDir !== undefined) base.DEFIGENT_DATA_DIR = dataDir;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A data directory with the inbox's ledger and the given actions; returns { dir, store, close }.
function ledger(actions = []) {
  const dir = mkdtempSync(join(tmpdir(), "jobs-actions-test-"));
  const db = new Database(join(dir, "defigent_a2a.db"));
  migrateJobsStore(db);
  const store = createJobsStore(db);
  const now = Math.floor(Date.now() / 1000);
  for (const a of actions) {
    store.enqueueAction({ key: a.key, action: a.action, payload: a.payload, contextId: a.contextId ?? "ctx-1", now });
    if (a.state || a.result) store.finishAction(a.key, a.state ?? "pending", a.result ?? null, now);
  }
  return { dir, store, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const review = { key: `review_offer:${OFFER_ID}`, action: "review_offer", payload: { offerId: OFFER_ID, side: "provider", service: "hash-text", from: null } };
const fund = { key: "fund:42", action: "fund", payload: { jobId: "42", token: USDC, amount: "250000" } };
const createJob = {
  key: "create_job:of_AbCdEf1234", action: "create_job",
  payload: {
    offerId: "of_AbCdEf1234", provider: "0x1111111111111111111111111111111111111111", agentId: 777, evaluator: cfg.evaluator, hook: cfg.hook,
    expiredAt: 1792800000, description: '{"offerId":"of_AbCdEf1234","terms":"0x00","v":1}', token: USDC, amount: "250000",
  },
};

test("DEFIGENT_DATA_DIR is required and the ledger must already exist", async () => {
  const none = await run(["list"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /DEFIGENT_DATA_DIR is required/);
  const empty = mkdtempSync(join(tmpdir(), "jobs-actions-empty-"));
  try {
    const r = await run(["list"], { dataDir: empty });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot open .*defigent_a2a\.db/);
    assert.equal(existsSync(join(empty, "defigent_a2a.db")), false, "the script never creates a ledger");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("an action that is not pending is refused", async () => {
  const l = ledger([{ ...fund, state: "done", result: { txs: [] } }]);
  try {
    const r = await run(["apply", fund.key], { dataDir: l.dir, env: { DEFIGENT_PRIVATE_KEY: NOT_OUR_KEY } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /action fund:42 is done, not pending/);
  } finally {
    l.close();
  }
});

test("a create_job that already sent a transaction is never sent again, and the claim is released", async () => {
  const l = ledger([{ ...createJob, result: { sent: ["0xabc"] } }]);
  try {
    const r = await run(["apply", createJob.key], { dataDir: l.dir, env: { DEFIGENT_PRIVATE_KEY: NOT_OUR_KEY } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already sent 0xabc; sending it again is not safe/);
    assert.deepEqual([l.store.getAction(createJob.key).state, l.store.getAction(createJob.key).result], ["pending", { sent: ["0xabc"] }]);
  } finally {
    l.close();
  }
});

test("a key that is not the configured signer stops the run before any chain call, and the claim is released", async () => {
  const l = ledger([fund]);
  try {
    const r = await run(["apply", fund.key], { dataDir: l.dir, env: { DEFIGENT_PRIVATE_KEY: NOT_OUR_KEY } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`fund is signed by config\\.client ${cfg.client}, but the key is 0x`));
    assert.ok(!r.stderr.includes("01".repeat(32)), "the key is never printed");
    assert.deepEqual([l.store.getAction(fund.key).state, l.store.getAction(fund.key).result], ["pending", null]);
  } finally {
    l.close();
  }
});

test("an action another run has claimed is refused and left as it is", async () => {
  const claim = { id: "other-run", pid: 1, at: Math.floor(Date.now() / 1000) };
  const l = ledger([{ ...fund, result: { claim } }]);
  try {
    const r = await run(["apply", fund.key], { dataDir: l.dir, env: { DEFIGENT_PRIVATE_KEY: NOT_OUR_KEY } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /action fund:42 is being applied by another run/);
    assert.deepEqual(l.store.getAction(fund.key).result, { claim });
  } finally {
    l.close();
  }
});

test("two concurrent applies of the same action: exactly one runs it and writes the outbox line", async () => {
  const l = ledger([review]);
  try {
    const runs = await Promise.all([1, 2, 3].map(() => run(["apply", review.key, "--verdict", "decline"], { dataDir: l.dir })));
    const ok = runs.filter((r) => r.code === 0);
    assert.equal(ok.length, 1, runs.map((r) => r.stderr).join("\n"));
    for (const r of runs.filter((x) => x.code !== 0)) assert.match(r.stderr, /being applied by another run|is done, not pending/);
    const lines = readFileSync(join(l.dir, "defigent_outbox.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    assert.deepEqual(lines, [{
      contextId: "ctx-1", text: `Defigent declines offer ${OFFER_ID}.`, state: "rejected",
      data: { "defigent.job.decline": { offerId: OFFER_ID, reason: "other" } }, replyId: review.key,
    }]);
    const row = l.store.getAction(review.key);
    assert.deepEqual([row.state, row.result], ["done", { verdict: "decline" }]);
  } finally {
    l.close();
  }
});
