// Runs the operator actions of the typed jobs protocol (review_offer, create_job, gas_grant, fund, evaluate, refund, review_claim).
// Usage: node scripts/jobs_actions.mjs list
//        node --env-file=/home/ubuntu/.hermes/.env scripts/jobs_actions.mjs apply <key> [--verdict complete|reject|accept|decline]
//          [--reason <text>] [--party-address 0x… --party-agent-id <n>] [--dry-run]
// apply simulates each transaction from the signer, sends it and waits for its receipt, one at a time and in order (R33). It then
// marks the action done, appends the result line to the outbox (the inbox verifies it on chain) and, best effort, pushes the typed
// notice to the peer's endpoint. --dry-run prints the transactions and stops before the key, the chain and any write.
import fs from "node:fs";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { createPublicClient, defineChain, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildTypedMessage, sendTyped } from "../jobs/a2a_client.mjs";
import { loadJobsConfig } from "../jobs/config.mjs";
import { KEY_PREFIX } from "../jobs/protocol.mjs";
import { createJobsStore, migrateJobsStore } from "../jobs/store.mjs";
import { buildActionTxs, createdJobId, outboxLineFor } from "../jobs/tx.mjs";

const USAGE = "usage: node scripts/jobs_actions.mjs list\n" +
  "       node --env-file=/home/ubuntu/.hermes/.env scripts/jobs_actions.mjs apply <key> [--verdict complete|reject|accept|decline] [--reason <text>] " +
  "[--party-address 0x… --party-agent-id <n>] [--dry-run]";
const DEC_RE = /^(0|[1-9][0-9]*)$/;
const VERDICTS = { evaluate: ["complete", "reject"], review_offer: ["accept", "decline"] };
// Sending these twice is not caught by the simulation (a second job, a second grant), so a recorded send blocks a retry.
const NOT_RETRYABLE = new Set(["create_job", "gas_grant"]);
const RECEIPT_TIMEOUT_MS = 120000;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const json = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

function die(message) {
  console.error(`jobs_actions: ${message}`);
  process.exit(1);
}

let args;
let positionals;
try {
  ({ values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      verdict: { type: "string" }, reason: { type: "string" }, "party-address": { type: "string" }, "party-agent-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  }));
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}
const [command, key, ...extra] = positionals;
if (command === "list" ? positionals.length !== 1 : command !== "apply" || !key || extra.length) die(USAGE);

const config = loadJobsConfig();
const dataDir = process.env.DEFIGENT_DATA_DIR || "/home/ubuntu/.hermes/cache/scratch";
let db;
try {
  // The inbox owns the ledger: this script never creates one.
  db = new Database(`${dataDir}/defigent_a2a.db`, { fileMustExist: true });
} catch (e) {
  die(`cannot open ${dataDir}/defigent_a2a.db (set DEFIGENT_DATA_DIR): ${e.message}`);
}
migrateJobsStore(db);
const store = createJobsStore(db);

if (command === "list") {
  const pending = store.listActions("pending").map(({ key: k, action, contextId, payload, createdAt, wokenAt }) => ({ key: k, action, contextId, payload, createdAt, wokenAt }));
  console.log(json(pending));
  process.exit(0);
}

const action = store.getAction(key);
if (!action) die(`no action ${JSON.stringify(key)}`);

const allowed = VERDICTS[action.action];
if (args.verdict !== undefined && !allowed) die(`--verdict does not apply to ${action.action}`);
if (allowed && !allowed.includes(args.verdict)) die(`${action.action} needs --verdict ${allowed.join("|")}`);

// The provider identity of an accept verdict: the flags, or the sender the inbound offer named (plan decision 1).
function partyFor() {
  if (action.action !== "review_offer" || args.verdict !== "accept") return undefined;
  const address = args["party-address"];
  const agentId = args["party-agent-id"];
  if (address === undefined && agentId === undefined) {
    if (!action.payload.from) die("the offer names no sender: --party-address and --party-agent-id are required to accept it");
    return action.payload.from;
  }
  if (address === undefined || agentId === undefined) die("--party-address and --party-agent-id go together");
  if (!isAddress(address, { strict: false })) die(`--party-address is not an address: ${JSON.stringify(address)}`);
  if (!DEC_RE.test(agentId) || !Number.isSafeInteger(Number(agentId))) die(`--party-agent-id must be a non-negative integer: ${JSON.stringify(agentId)}`);
  return { address: getAddress(address), agentId: Number(agentId) };
}
const party = partyFor();

let txs;
try {
  txs = buildActionTxs(action, config, { verdict: args.verdict, reason: args.reason });
} catch (e) {
  die(e.message);
}
const signerRole = action.action === "evaluate" ? "evaluator" : "client";

if (args["dry-run"]) {
  const preview = { key: action.key, action: action.action, state: action.state, contextId: action.contextId, payload: action.payload };
  if (txs.length) Object.assign(preview, { signer: { role: signerRole, address: config[signerRole] }, txs });
  // Without transactions the outbox line is already known.
  else preview.outbox = outboxLineFor(action, { verdict: args.verdict, party });
  console.log(json(preview));
  process.exit(0);
}

if (action.state !== "pending") die(`action ${key} is ${action.state}, not pending`);
const sentBefore = action.result?.sent ?? [];
if (sentBefore.length && NOT_RETRYABLE.has(action.action))
  die(`action ${key} already sent ${sentBefore.join(", ")}; sending it again is not safe. Check those transactions on chain and settle the action by hand.`);

const mined = [];
let jobId;
if (txs.length) {
  const raw = process.env.DEFIGENT_PRIVATE_KEY;
  delete process.env.DEFIGENT_PRIVATE_KEY;
  if (!raw) die("DEFIGENT_PRIVATE_KEY is not set: run with node --env-file=/home/ubuntu/.hermes/.env");
  let account;
  try {
    account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    die("DEFIGENT_PRIVATE_KEY is not a valid private key"); // the error text could echo the key, so it is not printed
  }
  if (account.address !== config[signerRole]) die(`${action.action} is signed by config.${signerRole} ${config[signerRole]}, but the key is ${account.address}`);

  const rpcUrl = process.env.RPC_URL || "https://rpc.monad.xyz";
  const chain = defineChain({ id: config.chainId, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pc = createPublicClient({ chain, transport: http(rpcUrl) });
  const reasonOf = (e) => String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 300);
  const minedSoFar = () => (mined.length ? ` Already mined: ${mined.map((t) => `${t.label} ${t.hash}`).join(", ")}.` : "");

  for (const tx of txs) {
    const call = { account: account.address, to: tx.to, data: tx.data, ...(tx.value !== undefined ? { value: tx.value } : {}) };
    let gas;
    let nonce;
    let gasPrice;
    try {
      await pc.call(call);
      const estimate = await pc.estimateGas(call);
      gas = (estimate * 130n) / 100n;
      if (tx.gasFloor !== undefined && gas < tx.gasFloor) gas = tx.gasFloor;
      [nonce, gasPrice] = await Promise.all([pc.getTransactionCount({ address: account.address, blockTag: "pending" }), pc.getGasPrice()]);
    } catch (e) {
      die(`${tx.label} would revert or the chain did not answer: ${reasonOf(e)}.${minedSoFar()}`);
    }
    const signed = await account.signTransaction({ chainId: config.chainId, nonce, gasPrice: (gasPrice * 11n) / 10n, gas, to: tx.to, data: tx.data, ...(tx.value !== undefined ? { value: tx.value } : {}) });
    let hash;
    try {
      hash = await pc.sendRawTransaction({ serializedTransaction: signed });
    } catch (e) {
      die(`${tx.label} was not accepted by the RPC: ${reasonOf(e)}.${minedSoFar()}`);
    }
    // Recorded before waiting: a crash or a timeout from here on leaves a trace of what may land.
    store.finishAction(key, "pending", { sent: [...sentBefore, ...mined.map((t) => t.hash), hash] }, nowSeconds());
    console.error(`${tx.label}: sent ${hash}`);
    let receipt;
    try {
      receipt = await pc.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (e) {
      die(`${tx.label} ${hash}: no receipt yet (${reasonOf(e)}). Check it on chain before doing anything else.${minedSoFar()}`);
    }
    if (receipt.status !== "success") die(`${tx.label} ${hash} reverted.${minedSoFar()}`);
    mined.push({ label: tx.label, hash, logs: receipt.logs });
  }

  if (action.action === "create_job") {
    jobId = createdJobId(mined[0].logs, config.escrow);
    if (!jobId) {
      store.finishAction(key, "failed", { txs: mined.map(({ label, hash }) => ({ label, hash })), error: "no JobCreated log in the receipt" }, nowSeconds());
      die(`createJob ${mined[0].hash} was mined but its receipt has no JobCreated log from ${config.escrow}; the action is marked failed. Find the job on chain.`);
    }
  }
}

const txHash = mined.at(-1)?.hash;
const line = outboxLineFor(action, { txHash, jobId, verdict: args.verdict, party });
const result = {
  ...(mined.length ? { txs: mined.map(({ label, hash }) => ({ label, hash })) } : {}),
  ...(jobId ? { jobId } : {}),
  ...(args.verdict ? { verdict: args.verdict } : {}),
  ...(party ? { party } : {}),
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
};
store.finishAction(key, "done", result, nowSeconds());

const outboxFile = `${dataDir}/defigent_outbox.jsonl`;
if (line) {
  try {
    fs.appendFileSync(outboxFile, `${JSON.stringify(line)}\n`);
  } catch (e) {
    console.error(`jobs_actions: could not append to ${outboxFile} (${e.message}); append this line by hand:\n${JSON.stringify(line)}`);
  }
}

// R9: the push notice goes to the endpoint we sent the offer to, never to a URL that came in a message. Best effort.
let notice = null;
if (line?.data) {
  const offer = action.payload.offerId ? store.getOffer(action.payload.offerId) : store.findOfferByJobId(action.payload.jobId);
  if (offer?.peerEndpoint) {
    const [[fullName, body]] = Object.entries(line.data);
    const message = buildTypedMessage({ name: fullName.slice(KEY_PREFIX.length), body, contextId: offer.contextId ?? line.contextId, text: line.text });
    const sent = await sendTyped({ endpoint: offer.peerEndpoint, message });
    notice = { endpoint: offer.peerEndpoint, httpStatus: sent.status, ...(sent.error ? { error: sent.error } : {}) };
    if (sent.error) console.error(`jobs_actions: notice to ${offer.peerEndpoint} failed (HTTP ${sent.status}): ${sent.error.message ?? JSON.stringify(sent.error)}`);
  }
}

console.log(json({ key, action: action.action, state: "done", result, outbox: line ? { file: outboxFile, line } : null, notice }));
db.close();
