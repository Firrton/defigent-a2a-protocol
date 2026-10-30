// Sends a typed defigent.job.offer (we are the client) to a peer's A2A endpoint, records it in the offers ledger and runs
// the peer's synchronous typed answer through the jobs runtime.
// Usage: DEFIGENT_DATA_DIR=<inbox data dir> node scripts/send_offer.mjs --endpoint <url> --agent-id <n> --service <id>
//          --description <text> --amount <base units> [--token USDC] [--ttl <s>] [--dry-run]
// DEFIGENT_DATA_DIR is required (no default): the offer goes into the inbox's own ledger, <dir>/defigent_a2a.db, which must
// already exist (in production /home/ubuntu/defigent-data). Elsewhere the peer's accept would reach the inbox as unknown_offer.
// --dry-run prints the message and touches neither the database nor the network.
import { parseArgs } from "node:util";
import { buildTypedMessage, extractTyped, sendTyped } from "../jobs/a2a_client.mjs";
import { loadJobsConfig, tokenBySymbol } from "../jobs/config.mjs";
import { fullKey, newOfferId, parseTyped, termsHash } from "../jobs/protocol.mjs";

const USAGE = "usage: DEFIGENT_DATA_DIR=<inbox data dir> node scripts/send_offer.mjs --endpoint <url> --agent-id <n> --service <id> --description <text> --amount <base units> [--token USDC] [--ttl <s>] [--dry-run]";
const DEC_RE = /^(0|[1-9][0-9]*)$/;

function die(message) {
  console.error(`send_offer: ${message}`);
  process.exit(1);
}

function intArg(name, raw) {
  if (!DEC_RE.test(raw ?? "") || !Number.isSafeInteger(Number(raw))) die(`--${name} must be a non-negative integer: ${JSON.stringify(raw)}`);
  return Number(raw);
}

function formatUnits(amount, decimals) {
  const s = amount.toString().padStart(decimals + 1, "0");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, s.length - decimals)}.${frac}` : s.slice(0, s.length - decimals);
}

function offerText(offer, config) {
  const { price } = offer;
  return `Defigent (agent ${config.agentId}) offers ${formatUnits(BigInt(price.amount), price.decimals)} ${price.symbol} for "${offer.service}": ${offer.description.replace(/([^.!?])$/, "$1.")} ` +
    `Payment runs through the ERC-8183 escrow ${offer.settlement.escrow} on Monad (chainId ${offer.settlement.chainId}). ` +
    `To accept, reply with a ${fullKey("accept")} DataPart {offerId, party: {address, agentId}}, or with a text that carries ${offer.offerId} and your wallet address. ` +
    `We then create the job and fund it; you call setBudget and submit (2 transactions, gas paid by you), and the payment is released to you when our operator accepts the deliverable. ` +
    `This offer expires at ${new Date(offer.expiresAt * 1000).toISOString()}.`;
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      endpoint: { type: "string" }, "agent-id": { type: "string" }, service: { type: "string" }, description: { type: "string" },
      amount: { type: "string" }, token: { type: "string", default: "USDC" }, ttl: { type: "string" }, "dry-run": { type: "boolean", default: false },
    },
  }));
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}
for (const k of ["endpoint", "agent-id", "service", "description", "amount"]) if (args[k] === undefined) die(`--${k} is required\n${USAGE}`);
try {
  if (!/^https?:$/.test(new URL(args.endpoint).protocol)) throw new Error("not http(s)");
} catch {
  die(`--endpoint must be an http(s) URL: ${JSON.stringify(args.endpoint)}`);
}

const config = loadJobsConfig();
const agentId = intArg("agent-id", args["agent-id"]);
const ttl = args.ttl === undefined ? config.minOfferTtlSeconds : intArg("ttl", args.ttl);
const token = tokenBySymbol(config, args.token);
if (!token) die(`unknown --token ${JSON.stringify(args.token)} (known: ${Object.keys(config.tokens).join(", ")})`);
if (!DEC_RE.test(args.amount)) die(`--amount must be a decimal string of base units: ${JSON.stringify(args.amount)}`);
if (BigInt(args.amount) > config.caps.maxOfferAmount) die(`--amount ${args.amount} is above caps.maxOfferAmount ${config.caps.maxOfferAmount}`);

const now = Math.floor(Date.now() / 1000);
const offerId = newOfferId();
const parsed = parseTyped("offer", {
  offerId,
  side: "client",
  service: args.service,
  description: args.description,
  price: { amount: args.amount, token: token.address, decimals: token.decimals, symbol: token.symbol },
  settlement: { chainId: config.chainId, escrow: config.escrow },
  deliverable: { mediaType: "application/json", acceptance: "operator" },
  providerSteps: ["setBudget", "submit"],
  gas: { providerTxs: 2, grant: null },
  from: { address: config.client, agentId: config.agentId },
  to: { agentId },
  replyTo: { url: config.inboxUrl, contextId: offerId },
  expiresAt: now + Math.max(ttl, config.minOfferTtlSeconds),
});
if (!parsed.ok) die(`invalid offer: ${parsed.field} ${parsed.detail}`);
const offer = parsed.value;
const message = buildTypedMessage({ name: "offer", body: offer, contextId: offerId, text: offerText(offer, config) });

// R26: a dry run returns before any database or network is opened.
if (args["dry-run"]) {
  console.log(JSON.stringify(message, null, 2));
  process.exit(0);
}

const { default: Database } = await import("better-sqlite3");
const { createChainReader } = await import("../jobs/chain.mjs");
const { createJobsRuntime } = await import("../jobs/runtime.mjs");

const dataDir = process.env.DEFIGENT_DATA_DIR;
if (!dataDir) die(`DEFIGENT_DATA_DIR is required: the inbox's data directory (production: /home/ubuntu/defigent-data)\n${USAGE}`);
let db;
try {
  // The inbox owns the ledger: an offer recorded anywhere else is unknown to the inbox that receives the accept.
  db = new Database(`${dataDir}/defigent_a2a.db`, { fileMustExist: true });
} catch (e) {
  die(`cannot open ${dataDir}/defigent_a2a.db (DEFIGENT_DATA_DIR must be the inbox's data directory): ${e.message}`);
}
// R3: no onAction, so actions stay unwoken and the server's sweep wakes them.
const runtime = createJobsRuntime({
  db, config, reader: createChainReader({ config, rpcUrl: process.env.RPC_URL || "https://rpc.monad.xyz" }), log: (...a) => console.error(...a),
});

const open = runtime.store.countOpenOffersForAgent(agentId, now);
if (open >= config.caps.maxOpenOffersPerAgent) die(`agent ${agentId} already has ${open} open offers (caps.maxOpenOffersPerAgent ${config.caps.maxOpenOffersPerAgent})`);

runtime.store.insertOffer({
  offerId, direction: "out", peerAgentId: agentId, peerAddress: null, peerEndpoint: args.endpoint, contextId: offerId,
  terms: offer, termsHash: termsHash(offer), state: "open", expiresAt: offer.expiresAt, createdAt: now,
});

const sent = await sendTyped({ endpoint: args.endpoint, message });
const replies = [];
if (sent.result !== undefined) {
  const typed = extractTyped(sent.result);
  for (const [i, part] of typed.entries()) {
    // R4: only the peer's answer goes through the handler; our own offer echoed back and user-role messages are skipped.
    if (part.name === "offer" || part.role === "user") continue;
    const out = await runtime.process({
      detection: { kind: "typed", name: part.name, body: part.body },
      contextId: offerId,
      sender: null,
      messageId: part.messageId ?? `sync-${offerId}-${i}`,
    });
    replies.push({
      name: part.name, kind: out.kind, reply: out.name ?? null, taskState: out.taskState ?? null, actions: (out.actions ?? []).map((a) => a.key),
      ...(out.kind === "invalid" ? { field: out.field, detail: out.detail } : {}),
    });
  }
}

// No new state on failure: the offer stays 'open' until expiresAt, after which countOpenOffersForAgent ignores it.
if (sent.status === 0 || sent.result === undefined) console.error(`send failed; offer stays open until ${offer.expiresAt}`);
console.log(JSON.stringify({ offerId, endpoint: args.endpoint, httpStatus: sent.status, ...(sent.error ? { error: sent.error } : {}), offerState: runtime.store.getOffer(offerId)?.state, replies }, null, 2));
db.close();
process.exit(sent.error ? 2 : 0);
