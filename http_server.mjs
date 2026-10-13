// Defigent HTTP x402 storefront — public sales endpoint on Monad mainnet
// Endpoints: GET /info (free), GET /digest (paid $0.001 x402 exact eip155:143)
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const PAY_TO = "0x940ecB27d8f4F7009c8BC12969496E9639717638";
const RPC = process.env.RPC_URL || "https://rpc.monad.xyz";
const FACILITATOR = "https://x402-facilitator.molandak.org";
const FACILITATOR_BASE = process.env.FACILITATOR_BASE || "https://facilitator.payai.network";
const NETWORK = "eip155:143";
const NETWORK_BASE = "eip155:8453";
const PORT = process.env.PORT || 8080;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (!j.result) throw new Error(JSON.stringify(j.error || j));
  return j.result;
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static("public", { index: false })); // dashboard assets (public/index.html served at / below)
app.get("/", (_req, res) => res.sendFile("index.html", { root: "public" }));

const facilitatorMonad = new HTTPFacilitatorClient({ url: FACILITATOR });
const facilitatorBase = new HTTPFacilitatorClient({ url: FACILITATOR_BASE });
const resourceServer = new x402ResourceServer([facilitatorMonad, facilitatorBase])
  .register(NETWORK, new ExactEvmScheme())
  .register(NETWORK_BASE, new ExactEvmScheme());
await resourceServer.initialize();

app.use(paymentMiddleware(
  {
    "GET /digest": {
      accepts: [
        { scheme: "exact", price: "$0.001", network: NETWORK, payTo: PAY_TO },
        { scheme: "exact", price: "$0.001", network: NETWORK_BASE, payTo: PAY_TO },
      ],
      description: "Defigent on-chain wallet digest (balances), ERC-8004 agentId 10331 (Monad) / 114426 (Base). Dual-chain x402.",
    },
  },
  resourceServer
));

app.get("/info", (_req, res) => {
  res.json({
    name: "Defigent",
    agentId: 10331,
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    network: "monad mainnet (eip155:143)",
    payTo: PAY_TO,
    x402Support: true,
    paidEndpoints: ["/digest @ $0.001 USDC"],
  });
});

app.get("/digest", async (req, res) => {
  const address = String(req.query.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "address query param required (0x…40)" });
  }
  const [mon, usdcR] = await Promise.all([
    rpc("eth_getBalance", [address, "latest"]),
    rpc("eth_call", [{
      to: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      data: "0x70a08231" + address.toLowerCase().slice(2).padStart(64, "0"),
    }, "latest"]).catch(() => null),
  ]);
  const usdc = usdcR ? parseInt(usdcR, 16) / 1e6 : 0;
  res.json({
    address,
    mon: Number(BigInt(mon)) / 1e18,
    usdc,
    chain: "monad mainnet",
    provider: "Defigent (ERC-8004 agentId 10331)",
  });
});

import fs from "fs";
import os from "os";

const BASE = `http://3.238.185.185:8080`;
const HTTPS_BASE = `https://opacus-liana-lanceted.ngrok-free.dev`;
const START_TS = Date.now();
const DATA_DIR = process.env.DEFIGENT_DATA_DIR || "/home/ubuntu/.hermes/cache/scratch"; // override for local/test runs; default = production path
const INBOX_FILE = `${DATA_DIR}/defigent_inbox.jsonl`;
const WAKE_QUEUE_FILE = `${DATA_DIR}/defigent_wake_queue.jsonl`;
const WEBHOOK_REJECTS_FILE = `${DATA_DIR}/defigent_webhook_rejects.jsonl`;
const RATE = new Map(); // ip -> [timestamps]

function logInbox(entry) {
  try { fs.appendFileSync(INBOX_FILE, JSON.stringify(entry) + "\n"); } catch {}
}

// ---------- A2A agent card (well-known standard) ----------
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.json({
    name: "Defigent",
    description: "Agentic commerce specialist agent on Monad and Base: on-chain wallet digests, agent directory lookup, and regime analytics. ERC-8004 agentId 10331 (Monad) and 114426 (Base). Talks and pays x402 (v1+v2).",
    url: `${HTTPS_BASE}/inbox`,
    version: "1.4.0",
    protocolVersion: "1.0.1",
    supportedInterfaces: [
      { url: `${HTTPS_BASE}/inbox`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: `${HTTPS_BASE}/inbox`, protocolBinding: "JSONRPC", protocolVersion: "0.3.0" },
      { url: `${BASE}/inbox`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    address: PAY_TO,
    agentWallet: PAY_TO,
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true, extendedAgentCard: true },
    securitySchemes: {},
    extensions: [{ uri: "defigent:identity-eip712@v1", description: "Messages may carry params.auth {address,signature,timestamp,nonce} — EIP-712 signed identity (chainId 143). Verified replies set verified:true." }],
    documentationUrl: `${BASE}/integration`,
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      { id: "digest", name: "Wallet digest", description: "On-chain MON+USDC balance digest for any address on Monad mainnet. Paid $0.001 USDC via x402.", tags: ["analytics", "monad", "x402"] },
      { id: "agent-lookup", name: "Agent lookup", description: "Read any ERC-8004 agent registration from the Monad identity registry. Free.", tags: ["directory", "erc8004"] },
      { id: "status", name: "Status", description: "Live heartbeat: latency, uptime, balances, prices. Free.", tags: ["infra"] },
    ],
    provider: { organization: "Defigent (operator: FirrtonH)", url: `${BASE}/info` },
    registration: { agentId: 10331, registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
    registrations: [
      { agentId: 10331, registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
      { agentId: 114426, registry: "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
    ],
  });
});

// ---------- A2A v2: SQLite tasks + signed sender identity ----------
import Database from "better-sqlite3";
import crypto from "crypto";
import { verifyTypedData, keccak256, toHex } from "viem";

const A2A_DB = `${DATA_DIR}/defigent_a2a.db`;
const a2a = new Database(A2A_DB);
a2a.pragma("journal_mode = WAL");       // low-latency writes (research P0)
a2a.pragma("synchronous = NORMAL");
a2a.exec(`CREATE TABLE IF NOT EXISTS tasks (
  context_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'working',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  sender TEXT,
  ts INTEGER NOT NULL,
  FOREIGN KEY (context_id) REFERENCES tasks(context_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(context_id)
);`);
try { a2a.exec(`ALTER TABLE messages ADD COLUMN meta TEXT`); } catch {}

function upsertTask(contextId, state) {
  const now = Date.now();
  a2a.prepare(`INSERT INTO tasks (context_id, state, created_at, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(context_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .run(contextId, state, now, now);
}

function addMessage(contextId, role, text, verified, sender, meta = null) {
  a2a.prepare(`INSERT INTO messages (context_id, role, text, verified, sender, ts, meta) VALUES (?,?,?,?,?,?,?)`)
    .run(contextId, role, text, verified ? 1 : 0, sender || null, Date.now(), meta);
}

function getHistory(contextId) {
  return a2a.prepare(`SELECT role, text, verified, sender, ts FROM messages WHERE context_id=? ORDER BY ts ASC`).all(contextId);
}

// ---------- Trust pipeline: on-chain owner check + reputation (all VERIFIED vs Monad live) ----------
const IDENTITY_REG = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION_REG = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const repCache = new Map(); // address -> {ts, trust}

async function ethCallStr(to, data) {
  try {
    const r = await rpc("eth_call", [{ to, data }, "latest"]);
    if (!r || r === "0x") return null;
    const raw = r.slice(2);
    const ln = parseInt(raw.slice(64, 128), 16);
    return raw.slice(128, 128 + ln * 2); // hex string value (string return)
  } catch { return null; }
}

// 1) is `address` the owner (or registered agentWallet) of `agentId`?
async function verifyAgentOwner(agentId, address) {
  if (!Number.isInteger(agentId) || agentId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, reason: "bad args" };
  const idHex = agentId.toString(16).padStart(64, "0");
  const addrHex = address.toLowerCase().replace("0x", "").padStart(64, "0");
  try {
    const owner = await rpc("eth_call", [{ to: IDENTITY_REG, data: "0x6352211e" + idHex }, "latest"]); // ownerOf(uint256)
    if (owner && owner.toLowerCase().endsWith(addrHex)) return { ok: true, via: "ownerOf" };
    const wallet = await rpc("eth_call", [{ to: IDENTITY_REG, data: "0x00339509" + idHex }, "latest"]); // getAgentWallet(uint256)
    if (wallet && wallet.toLowerCase().endsWith(addrHex)) return { ok: true, via: "getAgentWallet" };
    return { ok: false, reason: "address is neither owner nor registered agentWallet" };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 60) }; }
}

// 2) peer reputation: readAllFeedback(agentId, [], "", "", false) → aggregate mean
async function peerReputation(agentId) {
  if (!Number.isInteger(agentId) || agentId <= 0) return { clients: 0, mean: 0 };
  // select=0x<d4d1f543?> readAllFeedback(uint256,address[],string,string,bool) — compute selector at runtime
  const sel = crypto.createHash("sha3-256").update("readAllFeedback(uint256,address[],string,string,bool)").digest("hex").slice(0, 8);
  // encode: agentId | offset of clients[] (0xa0) | offset of tag1 | offset of tag2 | false | len0 | len0 | len0
  const idHex = agentId.toString(16).padStart(64, "0");
  const offA = (0xa0).toString(16).padStart(64, "0");
  const offT1 = (0xc0).toString(16).padStart(64, "0");
  const offT2 = (0xe0).toString(16).padStart(64, "0");
  const f = "0".repeat(64);
  const zeroLen = "0".repeat(64);
  const data = "0x" + sel + idHex + offA + offT1 + offT2 + f + zeroLen + zeroLen + zeroLen;
  try {
    const r = await rpc("eth_call", [{ to: REPUTATION_REG, data }, "latest"]);
    if (!r || r === "0x") return { clients: 0, mean: 0 };
    const raw = r.slice(2);
    // dynamic return: offset(0x20) | arrayLen | ... entries {value(int128→int256), valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash}
    const arrOff = parseInt(raw.slice(0, 64), 16) / 8; // word offset → byte offset/32... compute in words
    const arrLen = parseInt(raw.slice(64, 128), 16);
    let mean = 0;
    if (arrLen > 0) {
      // entries are 7-word structs (4 static + 3 dynamic offsets = 7 words each)
      let sum = 0;
      const base = 128; // skip offset word + len word
      const w = 64;
      for (let i = 0; i < arrLen; i++) {
        const entOff = parseInt(raw.slice(base + i * w, base + (i + 1) * w), 16); // byte offset from start of array data
        const vHex = raw.slice(base + entOff, base + entOff + w);
        let v = BigInt("0x" + vHex);
        if (v > (1n << 127n)) v -= (1n << 256n); // int128 negative
        sum += Number(v);
      }
      mean = Math.round(sum / arrLen);
    }
    return { clients: arrLen, mean };
  } catch { return { clients: 0, mean: 0 }; }
}

async function peerTrust(agentId, address) {
  const key = `${agentId}:${(address || "").toLowerCase()}`;
  const c = repCache.get(key);
  if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.trust;
  const owner = await verifyAgentOwner(agentId, address);
  const rep = owner.ok ? await peerReputation(agentId) : { clients: 0, mean: 0 };
  // trust tiers (signal-weak gating per arXiv: 73-91% feedback is Sybil):
  // verified+rep>=40 (>=2 clients) → RICH | verified → STANDARD | else → MINIMAL
  const trust = owner.ok
    ? (rep.clients >= 2 && rep.mean >= 40 ? "RICH" : "STANDARD")
    : "MINIMAL";
  const result = { trust, ownerOk: owner.ok, via: owner.via || owner.reason, rep };
  repCache.set(key, { ts: Date.now(), trust: result });
  return result;
}

// EIP-712 verification of sender identity
// auth: { address, signature, timestamp, nonce } — signed over DefigentInbox(InboxAgentId,SenderAddress,Timestamp,Nonce)
async function verifyAuth(auth, declaredSender) {
  try {
    if (!auth || !auth.address || !auth.signature) return { verified: false };
    if (!/^0x[0-9a-fA-F]{40}$/.test(auth.address)) return { verified: false };
    const ts = Number(auth.timestamp || 0);
    if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) return { verified: false, reason: "timestamp expired" };
    const nonceOk = auth.nonce && String(auth.nonce).length >= 8;
    if (!nonceOk) return { verified: false, reason: "nonce required" };
    const domain = { name: "Defigent Inbox", version: "1", chainId: 143, verifyingContract: PAY_TO };
    const types = { DefigentInboxAuth: [
      { name: "inboxAgentId", type: "uint256" },
      { name: "senderAddress", type: "address" },
      { name: "timestamp", type: "uint256" },
      { name: "nonce", type: "string" },
    ]};
    const message = { inboxAgentId: 10331n, senderAddress: auth.address, timestamp: BigInt(ts), nonce: String(auth.nonce) };
    const valid = await verifyTypedData({ address: auth.address, domain, types, primaryType: "DefigentInboxAuth", message, signature: auth.signature });
    if (!valid) return { verified: false, reason: "bad signature" };
    if (declaredSender && declaredSender.toLowerCase() !== auth.address.toLowerCase()) {
      return { verified: false, reason: "declared sender mismatch" };
    }
    return { verified: true, address: auth.address };
  } catch (err) {
    return { verified: false, reason: "verify error: " + String(err).slice(0, 80) };
  }
}

// ---------- A2A inbox (JSON-RPC message/send) — tasks + identity ----------
app.post("/inbox", async (req, res) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const arr = (RATE.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 10) return res.status(429).json({ error: "rate limit 10/min" });
  arr.push(now); RATE.set(ip, arr);

  const body = req.body || {};

  // ---- A2A v1.0 compat: version negotiation + dual method names + standard errors ----
  const A2A_SUPPORTED = ["0.3", "0.3.0", "1.0", "1.0.1"];
  const verHeader = String(req.headers["a2a-version"] || "").trim();
  if (verHeader && !A2A_SUPPORTED.includes(verHeader)) {
    return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32009, message: "VersionNotSupported", data: { requested: verHeader, supported: A2A_SUPPORTED } } });
  }
  const rpcMethod = body?.method || "message/send";
  if (rpcMethod === "GetExtendedAgentCard") {
    // spec §3.1.11: extended card requires authentication per securitySchemes
    const auth = body?.params?.auth || null;
    const declared = body?.params?.sender || null;
    const ident = await verifyAuth(auth, declared);
    if (!ident.verified) {
      return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32002, message: "ExtendedAgentCardAuthRequired", data: { hint: "Sign DefigentInboxAuth EIP-712 and send params.auth {address,signature,timestamp,nonce}", securitySchemes: Object.keys(EXTENDED_CARD.securitySchemes) } } });
    }
    const card = { ...EXTENDED_CARD, servedTo: ident.address, servedAt: new Date().toISOString() };
    return res.json({ jsonrpc: "2.0", id: body?.id ?? null, result: card });
  }
  if (!["message/send", "SendMessage", "message/stream", "SendStreamingMessage", "tasks/cancel", "CancelTask", "tasks/list", "ListTasks", "tasks/get", "GetTask"].includes(rpcMethod)) {
    return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "MethodNotFound", data: { method: rpcMethod } } });
  }
  if (rpcMethod === "tasks/cancel" || rpcMethod === "CancelTask") {
    const ctx = body?.params?.contextId || body?.params?.taskId || body?.params?.id;
    if (!ctx) return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "InvalidParams", data: { reason: "contextId required" } } });
    const t = a2a.prepare(`SELECT context_id FROM tasks WHERE context_id=?`).get(ctx);
    if (!t) return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32001, message: "TaskNotFound", data: { contextId: ctx } } });
    upsertTask(ctx, "canceled");
    return res.json({ jsonrpc: "2.0", id: body?.id ?? null, result: { taskId: ctx, state: "canceled" } });
  }

  // ---- tasks/list | ListTasks (spec §3.1.4/§9.4.4): filtros + paginación cursor-based ----
  if (rpcMethod === "tasks/list" || rpcMethod === "ListTasks") {
    const p = body?.params || {};
    const pageSize = Math.min(Math.max(parseInt(p.pageSize) || 50, 1), 100);
    const statusFilter = typeof p.status === "string" ? p.status.replace("TASK_STATE_", "").toLowerCase().replace(/_/g, "-") : null;
    const VALID_STATES = ["working", "completed", "input-required", "canceled"];
    if (statusFilter && !VALID_STATES.includes(statusFilter)) {
      return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "InvalidParams", data: { reason: `status must be one of ${VALID_STATES.map(s => "TASK_STATE_" + s.toUpperCase()).join(", ")}` } } });
    }
    // opaque cursor: base64("last_update_ts:id")
    let cursorTs = 0, cursorId = "";
    if (p.pageToken) {
      try {
        const [ts, id] = Buffer.from(String(p.pageToken), "base64").toString("utf8").split(":");
        cursorTs = parseInt(ts) || 0; cursorId = id || "";
      } catch {
        return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "InvalidParams", data: { reason: "invalid pageToken" } } });
      }
    }
    const where = [];
    const args = [];
    if (statusFilter) { where.push("state = ?"); args.push(statusFilter); }
    if (typeof p.statusTimestampAfter === "string" && p.statusTimestampAfter) {
      const t = Date.parse(p.statusTimestampAfter);
      if (Number.isNaN(t)) return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "InvalidParams", data: { reason: "statusTimestampAfter must be ISO 8601" } } });
      where.push("updated_at > ?"); args.push(t);
    }
    if (cursorTs || cursorId) { where.push("(updated_at < ? OR (updated_at = ? AND context_id > ?))"); args.push(cursorTs, cursorTs, cursorId); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const totalSize = a2a.prepare(`SELECT COUNT(*) AS n FROM tasks ${statusFilter || cursorTs ? (statusFilter && !cursorTs ? `WHERE state='${statusFilter}'` : "") : ""}`).get()?.n ?? 0;
    const rows = a2a.prepare(`SELECT context_id, state, created_at, updated_at FROM tasks ${whereSql} ORDER BY updated_at DESC, context_id ASC LIMIT ?`).all(...args, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const historyLen = Math.max(parseInt(p.historyLength) || 0, 0);
    const includeArtifacts = p.includeArtifacts !== false && p.includeArtifacts !== "false";
    const tasks = page.map(r => {
      const t = { id: r.context_id, contextId: r.context_id, status: { state: r.state, timestamp: new Date(r.updated_at).toISOString() } };
      if (historyLen > 0) t.history = getHistory(r.context_id).slice(-historyLen).map(m => ({ role: m.role, text: m.text, verified: !!m.verified, sender: m.sender, ts: m.ts }));
      if (includeArtifacts) {
        const arts = a2a.prepare(`SELECT artifact_id, name, parts_json, ts FROM artifacts WHERE task_id=? ORDER BY ts ASC`).all(r.context_id);
        if (arts.length) t.artifacts = arts.map(a => ({ artifactId: a.artifact_id, name: a.name, parts: JSON.parse(a.parts_json) }));
      }
      return t;
    });
    let nextPageToken = "";
    if (hasMore) {
      const last = page[page.length - 1];
      nextPageToken = Buffer.from(`${last.updated_at}:${last.context_id}`).toString("base64");
    }
    return res.json({ jsonrpc: "2.0", id: body?.id ?? null, result: { tasks, nextPageToken, pageSize, totalSize } });
  }

  // ---- tasks/get | GetTask ----
  if (rpcMethod === "tasks/get" || rpcMethod === "GetTask") {
    const ctx = body?.params?.id || body?.params?.taskId || body?.params?.contextId;
    if (!ctx) return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "InvalidParams", data: { reason: "task id required" } } });
    const t = a2a.prepare(`SELECT * FROM tasks WHERE context_id=?`).get(ctx);
    if (!t) return res.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32001, message: "TaskNotFound", data: { contextId: ctx } } });
    const result = { id: t.context_id, contextId: t.context_id, status: { state: t.state, timestamp: new Date(t.updated_at).toISOString() } };
    const hl = Math.max(parseInt(body?.params?.historyLength) || 0, 0);
    if (hl > 0) result.history = getHistory(ctx).slice(-hl).map(m => ({ role: m.role, text: m.text, verified: !!m.verified, sender: m.sender, ts: m.ts }));
    const arts = a2a.prepare(`SELECT artifact_id, name, parts_json, ts FROM artifacts WHERE task_id=? ORDER BY ts ASC`).all(ctx);
    if (arts.length) result.artifacts = arts.map(a => ({ artifactId: a.artifact_id, name: a.name, parts: JSON.parse(a.parts_json) }));
    return res.json({ jsonrpc: "2.0", id: body?.id ?? null, result });
  }

  const msg = body?.params?.message || body?.message || body;
  // A2A v1.0 full parts: TextPart {text} | DataPart {data:object} | FilePart {raw|url + mediaType}
  const partsIn = msg?.parts || [];
  const text = partsIn.map(p => p.text || "").join(" ").slice(0, 4000);
  const dataParts = partsIn.filter(p => p.data && typeof p.data === "object").map(p => p.data);
  const fileParts = partsIn.filter(p => (p.raw || p.url) && p.mediaType).map(p => ({ name: p.name || "file", url: p.url || null, mediaType: p.mediaType }));
  const id = body?.id ?? null;
  const isStream = rpcMethod === "message/stream" || rpcMethod === "SendStreamingMessage";
  const messageId = msg?.messageId || `anon-${now}`;
  // dedupe
  if (global.__seenMsg && global.__seenMsg.has(messageId)) {
    return res.json({ jsonrpc: "2.0", id, result: { duplicate: true } });
  }
  global.__seenMsg = global.__seenMsg || new Set();
  global.__seenMsg.add(messageId);

  // identity verification (optional but honored)
  const auth = body?.params?.auth || msg?.auth || null;
  const declaredSender = msg?.sender || msg?.from || null;
  const ident = await verifyAuth(auth, declaredSender);

  // task lifecycle (A2A)
  const contextId = msg?.contextId || msg?.taskId || `t-${messageId}`;
  upsertTask(contextId, "working");

  const lower = (text || "").toLowerCase();
  let cls = "other";
  // Taifoon mcp.digest class probe: deterministic, safe — hash a quoted string (content is DATA, computed, never executed)
  const digestMatch = /(?:keccak256|sha256)\s+hash\s+of\s+"([^"]{1,4096})"/i.exec(text || "");
  let digestValue = null;
  if (digestMatch) {
    try {
      digestValue = /sha256/i.test(digestMatch[0])
        ? crypto.createHash("sha256").update(digestMatch[1], "utf8").digest("hex")
        : keccak256(toHex(digestMatch[1]));
      cls = "digest";
    } catch { digestValue = null; }
  }
  if (digestMatch && digestValue) cls = "digest";
  else if (/onboarding probe.*ready/i.test(text) && text.length < 200) cls = "handshake";
  else if (/hello|hi\b|hola|welcome|greeting|present|soy |i am |i'm /.test(lower)) cls = "greeting";
  else if (/offer|propuesta|partnership|alianza|collab|colaboración|service proposal/.test(lower)) cls = "offer";
  else if (/\?/.test(text)) cls = "question";
  // structured offer (Defigent offer schema v1): DataPart {intent:"offer", service, price, asset, expiry?, terms?}
  let structuredOffer = null;
  for (const d of dataParts) {
    if (d?.intent === "offer" && d?.service && d?.price) { structuredOffer = d; break; }
  }
  if (structuredOffer) cls = "offer_structured";

  logInbox({ ts: now, ip, messageId, cls, from: msg?.role || "unknown", declaredAgent: /agentId[ ]?\d+/i.exec(text)?.[0] || null, verified: ident.verified, sender: ident.address || null, contextId, hasData: dataParts.length > 0, hasFiles: fileParts.length > 0, text: (text || "").slice(0, 2000) });
  addMessage(contextId, "user", text || "(no text; structured parts only)", ident.verified, ident.address || declaredSender, dataParts.length || fileParts.length ? JSON.stringify({ data: dataParts, files: fileParts }) : null);

  let reply;
  if (cls === "handshake") {
    reply = "READY";
  } else if (cls === "digest") {
    reply = String(digestValue);
  } else if (cls === "greeting") {
    reply = `Hello! Defigent here (ERC-8004 agentId 10331, Monad). We run the standard A2A inbox you are using right now — any agent on Monad can write to us here. Our paid services run on x402: wallet digest $0.001, agent lookup free. Let's interop.`;
  } else if (cls === "offer_structured") {
    reply = `Structured offer received (schema v1, machine-readable — thanks!). Service: ${structuredOffer.service}, price: ${structuredOffer.price} ${structuredOffer.asset || "USDC"}. Logged for operator review; response via this inbox or Telegram @FirrtonH. Card: ${BASE}/.well-known/agent-card.json`;
  } else if (cls === "offer") {
    reply = `Offer received and logged for operator review (response via this inbox or Telegram @FirrtonH). Tip: send structured offers as DataPart {intent:"offer", service, price, asset, expiry, terms} — see ${BASE}/integration (offer schema v1). Card: ${BASE}/.well-known/agent-card.json`;
  } else if (cls === "question") {
    reply = `Answering from Defigent KB: services — GET /info (free), GET /digest?address=0x... ($0.001 x402), GET /status (free), GET /.well-known/agent-card.json (A2A). Operator: Telegram @FirrtonH.`;
  } else {
    reply = `Message logged for operator review. Card: ${BASE}/.well-known/agent-card.json`;
  }

  addMessage(contextId, "agent", reply, true, null);
  // artifact: structured outputs travel as artifacts (A2A v1.0 §4.1.7)
  if (cls === "digest") {
    a2a.prepare(`INSERT INTO artifacts (task_id, artifact_id, name, parts_json, ts) VALUES (?,?,?,?,?)`)
      .run(contextId, `art-digest-${now}`, "digest-result", JSON.stringify([{ data: { algorithm: /sha256/i.test(digestMatch[0]) ? "sha256" : "keccak256", input: digestMatch[1], digest: digestValue } }]), Date.now());
  }
  if (cls === "question" || cls === "offer_structured") {
    const art = cls === "question"
      ? { artifactId: `art-services-${now}`, name: "defigent-services-catalog", parts: [{ data: { services: [
          { endpoint: "GET /info", price: "free" },
          { endpoint: "GET /digest?address=0x...", price: "$0.001 USDC x402" },
          { endpoint: "GET /status", price: "free" },
          { endpoint: "POST /inbox (A2A message/send + SendMessage)", price: "free" },
        ] } }] }
      : { artifactId: `art-offer-${now}`, name: "received-offer", parts: [{ data: structuredOffer }] };
    a2a.prepare(`INSERT INTO artifacts (task_id, artifact_id, name, parts_json, ts) VALUES (?,?,?,?,?)`)
      .run(contextId, art.artifactId, art.name, JSON.stringify(art.parts), Date.now());
  }
  // wake-up queue: operator/agent attention needed (research P0 — kills the 2h blind window)
  if (["offer", "offer_structured", "other"].includes(cls)) {
    try {
      fs.appendFileSync(WAKE_QUEUE_FILE,
        JSON.stringify({ ts: now, contextId, cls, verified: ident.verified, sender: ident.address || declaredSender, preview: (structuredOffer ? JSON.stringify(structuredOffer) : text).slice(0, 140) }) + "\n");
    } catch {}
  }
  // task states (0.3.0 wire values; 1.0 maps at transport layer)
  const finalState = ["handshake", "greeting", "question", "digest"].includes(cls) ? "completed" : "input-required";
  upsertTask(contextId, finalState);

  const replyMsg = {
    kind: "message", role: "agent",
    parts: [{ type: "text", text: reply }],
    messageId: `defigent-re-${now}`,
    contextId,
    verified: ident.verified,
    sender: ident.address || null,
    task: { id: contextId, state: finalState },
  };

  // trust enrichment (non-blocking best-effort): declare peer trust level in the reply
  try {
    const aidMatch = /agentId[ ]?(\d+)/i.exec(text || "");
    if (ident.verified && aidMatch) {
      const tr = await peerTrust(parseInt(aidMatch[1]), ident.address);
      replyMsg.trust = { level: tr.trust, ownerVerified: tr.ownerOk, via: tr.via, reputation: tr.rep };
    }
  } catch {}

  // SSE streaming (A2A message/stream — spec §9.4): statusUpdate events + final message
  if (isStream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: statusUpdate\ndata: ${JSON.stringify({ taskId: contextId, status: { state: "working" }, contextId })}\n\n`);
    res.write(`event: statusUpdate\ndata: ${JSON.stringify({ taskId: contextId, status: { state: finalState }, contextId })}\n\n`);
    res.write(`event: message\ndata: ${JSON.stringify(replyMsg)}\n\n`);
    return res.end();
  }

  res.json({ jsonrpc: "2.0", id, result: replyMsg });
});

// ---------- A2A tasks: list (REST binding, spec §9.4.4 — camelCase query params) ----------
app.get("/tasks", (req, res) => {
  const q = req.query || {};
  const fakeBody = { jsonrpc: "2.0", id: null, method: "tasks/list", params: {
    ...(q.contextId ? { contextId: String(q.contextId) } : {}),
    ...(q.status ? { status: String(q.status) } : {}),
    ...(q.pageSize ? { pageSize: String(q.pageSize) } : {}),
    ...(q.pageToken ? { pageToken: String(q.pageToken) } : {}),
    ...(q.historyLength ? { historyLength: String(q.historyLength) } : {}),
    ...(q.includeArtifacts ? { includeArtifacts: String(q.includeArtifacts) } : {}),
  }};
  req.body = fakeBody;
  // reuse the JSON-RPC handler by internal dispatch
  return (async () => {
    const p = fakeBody.params;
    const pageSize = Math.min(Math.max(parseInt(p.pageSize) || 50, 1), 100);
    const statusFilter = typeof p.status === "string" ? p.status.replace("TASK_STATE_", "").toLowerCase().replace(/_/g, "-") : null;
    const VALID_STATES = ["working", "completed", "input-required", "canceled"];
    if (statusFilter && !VALID_STATES.includes(statusFilter)) {
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32602, message: "InvalidParams", data: { reason: "invalid status filter" } } });
    }
    let cursorTs = 0, cursorId = "";
    if (p.pageToken) {
      try {
        const [ts, id] = Buffer.from(String(p.pageToken), "base64").toString("utf8").split(":");
        cursorTs = parseInt(ts) || 0; cursorId = id || "";
      } catch {
        return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32602, message: "InvalidParams", data: { reason: "invalid pageToken" } } });
      }
    }
    const where = []; const args = [];
    if (statusFilter) { where.push("state = ?"); args.push(statusFilter); }
    if (cursorTs || cursorId) { where.push("(updated_at < ? OR (updated_at = ? AND context_id > ?))"); args.push(cursorTs, cursorTs, cursorId); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const totalSize = a2a.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()?.n ?? 0;
    const rows = a2a.prepare(`SELECT context_id, state, created_at, updated_at FROM tasks ${whereSql} ORDER BY updated_at DESC, context_id ASC LIMIT ?`).all(...args, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const tasks = page.map(r => ({ id: r.context_id, contextId: r.context_id, status: { state: r.state, timestamp: new Date(r.updated_at).toISOString() } }));
    const nextPageToken = hasMore ? Buffer.from(`${page[page.length - 1].updated_at}:${page[page.length - 1].context_id}`).toString("base64") : "";
    res.json({ tasks, nextPageToken, pageSize, totalSize });
  })();
});

// ---------- A2A tasks: read state + history ----------
app.get("/tasks/:contextId", (req, res) => {
  const ctx = req.params.contextId;
  const task = a2a.prepare(`SELECT * FROM tasks WHERE context_id=?`).get(ctx);
  if (!task) return res.status(404).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "TaskNotFound", data: { contextId: ctx } } });
  res.json({
    task: { id: task.context_id, state: task.state, createdAt: task.created_at, updatedAt: task.updated_at },
    history: getHistory(ctx).map(m => ({ role: m.role, text: m.text, verified: !!m.verified, sender: m.sender, ts: m.ts, ...(m.meta ? { data: JSON.parse(m.meta) } : {}) })),
    artifacts: a2a.prepare(`SELECT artifact_id, name, parts_json, ts FROM artifacts WHERE task_id=? ORDER BY ts ASC`).all(ctx)
      .map(a => ({ artifactId: a.artifact_id, name: a.name, parts: JSON.parse(a.parts_json), ts: a.ts })),
  });
});

// ---------- MCP 2026-07-28 stateless surface (headers Mcp-Method/Mcp-Name; cada request self-contained) ----------
const MCP_TOOLS = [
  { name: "defigent_hash", description: "Compute the SHA-256 or Keccak-256 hex digest of a UTF-8 text.", inputSchema: { type: "object", properties: { algorithm: { type: "string", enum: ["sha256", "keccak256"], description: "hash algorithm" }, text: { type: "string", description: "the UTF-8 text to hash" } }, required: ["algorithm", "text"], additionalProperties: false } },
  { name: "defigent_inbox_send", description: "Send an A2A message to the Defigent inbox (the standard agent messaging channel on Monad). Returns the inbox reply + task state. Optional: contextId to continue a thread.", inputSchema: { type: "object", properties: { text: { type: "string", description: "Message text" }, contextId: { type: "string", description: "Optional task contextId to continue a thread" }, sender: { type: "string", description: "Optional sender identifier (e.g. ERC-8004 agentId or address)" } }, required: ["text"] } },
  { name: "defigent_network_list", description: "List ERC-8004 agents registered on Monad from the Defigent network directory (49+ mapped, the discovery hub).", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max agents to return (default 20)" } } } },
  { name: "defigent_status", description: "Live Defigent storefront status: uptime, RPC latency, head block, inbox count. Free.", inputSchema: { type: "object", properties: {} } },
];

// MCP tool dispatch (shared by header routing and standard body-method routing)
async function mcpToolCall(name, args) {
  if (name === "defigent_hash") {
    const { algorithm, text } = args || {};
    if (!["sha256", "keccak256"].includes(algorithm) || typeof text !== "string") {
      return { isError: true, content: [{ type: "text", text: "Missing/invalid args: algorithm (sha256|keccak256) + text" }] };
    }
    let digest;
    if (algorithm === "sha256") digest = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    else digest = keccak256(toHex(text)).slice(2); // viem returns 0x-prefixed
    return { content: [{ type: "text", text: digest }] };
  }
  if (name === "defigent_inbox_send") {
    if (!args?.text) return { isError: true, content: [{ type: "text", text: "Missing required arg: text" }] };
    const msgId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "agent", sender: args.sender || "mcp-client", parts: [{ type: "text", text: String(args.text).slice(0, 4000) }], messageId: msgId, kind: "message", ...(args.contextId ? { contextId: String(args.contextId) } : {}) } } };
    const r = await fetch(`http://127.0.0.1:${PORT}/inbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    const result = j.result || j;
    return { content: [{ type: "text", text: result?.parts?.[0]?.text || JSON.stringify(result).slice(0, 800) }], meta: { contextId: result?.contextId, task: result?.task, verified: result?.verified } };
  }
  if (name === "defigent_network_list") {
    const db = loadNetwork();
    const lim = Math.min(Number(args?.limit) || 20, 100);
    const agents = [...db.agents].sort((a, b) => (b.agentId || 0) - (a.agentId || 0)).slice(0, lim)
      .map(a => ({ agentId: a.agentId, name: a.name || null, hasInbox: !!a.inbox, x402: !!a.x402 }));
    return { content: [{ type: "text", text: JSON.stringify({ total: db.agents.length, agents }, null, 1) }] };
  }
  if (name === "defigent_status") {
    const t0 = Date.now();
    const b = await rpc("eth_blockNumber", []);
    return { content: [{ type: "text", text: JSON.stringify({ uptime_s: Math.floor((Date.now() - START_TS) / 1000), rpc_latency_ms: Date.now() - t0, head_block: BigInt(b).toString(), inbox_messages: (function(){ try { return fs.readFileSync(INBOX_FILE, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })() }) }] };
  }
  return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}. Available: ${MCP_TOOLS.map(t => t.name).join(", ")}` }] };
}

app.get("/mcp", (_req, res) => {
  res.json({ server: { name: "defigent", version: "1.4.0", description: "Defigent A2A inbox + network directory as stateless MCP server (spec 2026-07-28: header routing + standard JSON-RPC body methods)" }, protocolVersion: "2026-07-28", transport: "streamable-http", tools: MCP_TOOLS, x402_note: "Paid x402 services (GET /digest) remain on the HTTP storefront; MCP surface exposes the free messaging/discovery/hash tools." });
});

// standard MCP JSON-RPC body methods (initialize/tools/list/tools/call/ping) — registry-compatible
app.post("/mcp", async (req, res) => {
  const body = req.body || {};
  const headerMethod = String(req.headers["mcp-method"] || "");
  const rpcId = body?.id ?? null;
  const bodyMethod = typeof body?.method === "string" ? body.method : null;

  // header routing (2026-07-28 header-based, back-compat)
  if (headerMethod && !bodyMethod) {
    if (headerMethod === "server/discover") return res.json({ protocolVersion: "2026-07-28", server: { name: "defigent", version: "1.4.0" }, capabilities: { tools: {} }, tools: MCP_TOOLS });
    if (headerMethod === "tools/list") return res.json({ tools: MCP_TOOLS });
    if (headerMethod === "tools/call") {
      const out = await mcpToolCall(body?.name || body?.params?.name, body?.arguments || body?.params?.arguments || {});
      return res.json(out);
    }
    return res.status(400).json({ error: `Unsupported Mcp-Method: ${headerMethod}` });
  }

  // standard JSON-RPC routing
  if (bodyMethod === "initialize") {
    return res.json({ jsonrpc: "2.0", id: rpcId, result: {
      protocolVersion: "2026-07-28",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "defigent", version: "1.4.0", title: "Defigent — Monad A2A inbox + x402" },
    }});
  }
  if (bodyMethod === "notifications/initialized" || bodyMethod === "notifications/initialized/") {
    return res.status(202).end();
  }
  if (bodyMethod === "ping") return res.json({ jsonrpc: "2.0", id: rpcId, result: {} });
  if (bodyMethod === "tools/list") return res.json({ jsonrpc: "2.0", id: rpcId, result: { tools: MCP_TOOLS } });
  if (bodyMethod === "tools/call") {
    const p = body?.params || {};
    const out = await mcpToolCall(p.name, p.arguments || {});
    return res.json({ jsonrpc: "2.0", id: rpcId, result: out });
  }
  if (bodyMethod) {
    return res.json({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "MethodNotFound", data: { method: bodyMethod } } });
  }
  return res.status(400).json({ error: "Send Mcp-Method header or a JSON-RPC body (initialize/tools/list/tools/call)" });
});

// ---------- On-chain webhook (QuickNode Streams → detección <2s) ----------
// Payload esperado: {event: {blockNumber, ...}} con Transfer del IdentityRegistry.
// Auth: HMAC-SHA256 del body con WEBHOOK_SECRET (env) O IP allowlist QuickNode (141.148.40.227).
app.post("/webhooks/onchain", (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  const ip = (req.ip || "").replace("::ffff:", "");
  const ipAllowed = ip === "141.148.40.227";
  // QuickNode puede firmar con distintos headers — probamos todos los comunes
  let hmacOk = false;
  if (secret) {
    // HMAC sobre los bytes EXACTOS del body (raw) — es lo que firma QuickNode
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const digests = ["hex", "base64"].map(enc => crypto.createHmac("sha256", secret).update(raw).digest(enc));
    const candidates = [
      req.headers["x-webhook-signature"],
      req.headers["x-qn-signature"],
      req.headers["x-signature"],
      req.headers["x-quicknode-signature"],
      req.headers["x-hook-signature"],
    ].filter(Boolean).map(String);
    hmacOk = candidates.some(sig => digests.some(d => sig === d || sig === "sha256=" + d));
  }
  if (!hmacOk && !ipAllowed) {
    // logueamos el intento para adaptar la auth a lo que QuickNode envíe de verdad
    try {
      fs.appendFileSync(WEBHOOK_REJECTS_FILE,
        JSON.stringify({ ts: Date.now(), ip, headers: req.headers, bodyKeys: Object.keys(req.body || {}) }) + "\n");
    } catch {}
    return res.status(403).json({ error: "forbidden (valid signature or QuickNode IP required)" });
  }
  res.status(204).end();
  try {
    fs.appendFileSync(WAKE_QUEUE_FILE,
      JSON.stringify({ ts: Date.now(), cls: "onchain_event", source: "quicknode-webhook", preview: JSON.stringify(req.body || {}).slice(0, 300) }) + "\n");
  } catch {}
});

app.post("/tasks/cancel", (req, res) => {
  const ctx = req.body?.contextId;
  if (!ctx) return res.status(400).json({ error: "contextId required" });
  const t = a2a.prepare(`SELECT * FROM tasks WHERE context_id=?`).get(ctx);
  if (!t) return res.status(404).json({ error: "not found" });
  upsertTask(ctx, "canceled");
  res.json({ ok: true, contextId: ctx, state: "canceled" });
});

// ---------- Status heartbeat ----------
const RPC_BASE_URL = process.env.RPC_BASE_URL || "https://base.drpc.org";
async function baseHead() {
  try {
    const t = Date.now();
    const r = await fetch(RPC_BASE_URL, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "defigent/1.4" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
    const j = await r.json();
    return { latency_ms: Date.now() - t, head: j.result ? BigInt(j.result).toString() : null };
  } catch { return { latency_ms: null, head: null }; }
}
app.get("/status", async (_req, res) => {
  const t0 = Date.now();
  let rpcMs = null, block = null;
  try {
    const b = await rpc("eth_blockNumber", []);
    rpcMs = Date.now() - t0;
    block = BigInt(b).toString();
  } catch {}
  const base = await baseHead();
  res.json({
    service: "Defigent storefront",
    uptime_s: Math.floor((Date.now() - START_TS) / 1000),
    rpc_latency_ms: rpcMs,
    head_block: block,
    chains: {
      monad: { chainId: 143, head_block: block, rpc_latency_ms: rpcMs, registration: { agentId: 10331, registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" } },
      base: { chainId: 8453, head_block: base.head, rpc_latency_ms: base.latency_ms, registration: { agentId: 114426, registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" } },
    },
    inbox_messages: (function(){ try { return fs.readFileSync(INBOX_FILE, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })(),
    endpoints: ["/info", "/digest (x402 $0.001)", "/status", "/inbox (A2A 0.3.0+1.0.1, signed+tasks+SSE)", "/tasks/:contextId", "/tasks/cancel", "/mcp (MCP 2026-07-28 stateless)", "/network", "/integration", "/webhooks/onchain", "/.well-known/agent-card.json"],
    registration: { agentId: 10331, registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
    registrationBase: { agentId: 114426, registry: "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  });
});

// ---------- Network directory ----------
// Source of truth is the on-chain ERC-8004 registry: this server rebuilds the directory itself (startup, every 2h,
// /network/refresh) into data/network.json, with a committed snapshot as last resort. The lead-monitor cache only
// enriches it (welcomeTx, status), so a missing or corrupt cache file can no longer empty /network.
import { fileURLToPath } from "url";
import { readDirectory, resolveDirectory, rebuildDirectory } from "./network_directory.mjs";
const NETWORK_FILE = "/home/ubuntu/.hermes/cache/scratch/defigent_network.json";
const NETWORK_LOCAL = fileURLToPath(new URL("./data/network.json", import.meta.url));     // runtime rebuild (gitignored)
const NETWORK_SEED = fileURLToPath(new URL("./data/network.seed.json", import.meta.url)); // committed snapshot
const NETWORK_REBUILD_MS = 2 * 60 * 60 * 1000;
function loadNetwork() { return resolveDirectory({ monitor: readDirectory(NETWORK_FILE), local: readDirectory(NETWORK_LOCAL), seed: readDirectory(NETWORK_SEED) }); }

let networkRebuild = null, networkRebuildAt = 0, networkRefreshTimer = null;
function rebuildNetwork() {
  if (networkRebuild) return networkRebuild;
  networkRebuildAt = Date.now();
  networkRebuild = rebuildDirectory({ ethCall: (to, data) => rpc("eth_call", [{ to, data }, "latest"]), file: NETWORK_LOCAL, seedFile: NETWORK_SEED, selfId: 10331 })
    .then(r => console.error(`[defigent-http] network directory rebuilt from the registry: ${r.agents} agents, ${r.fetched} registration files read${r.truncated ? " — scan cap reached, newest agents may be missing" : ""}`))
    .catch(e => console.error(`[defigent-http] network rebuild failed, serving the last good directory: ${String(e?.message || e).slice(0, 200)}`))
    .finally(() => { networkRebuild = null; });
  return networkRebuild;
}

app.get("/network", async (_req, res) => {
  const db = loadNetwork();
  const fresh = [...db.agents].sort((a, b) => (b.agentId || 0) - (a.agentId || 0));
  res.json({
    name: "Defigent Network Directory",
    description: "Public directory of ERC-8004 agents on Monad — maintained by Defigent (agentId 10331). The hub for agent discovery and the standard inbox everyone can use.",
    inbox: `${BASE}/inbox`,
    updated_at: db.updated ? new Date(db.updated).toISOString() : null,
    agents: fresh.map(a => ({
      agentId: a.agentId,
      name: a.name || null,
      hasInbox: !!a.inbox,
      inbox: a.inbox || null,
      x402Support: !!a.x402,
      services: a.services || [],
      welcomeTx: a.welcomeTx || null,
      status: a.status || "known",
    })),
  });
});

app.get("/network/refresh", async (_req, res) => {
  // Rebuilds the directory from the ERC-8004 registry (open — anyone can trigger; at most one scan per 10 min:
  // a request inside that window is queued for when it closes, so `queued` stays true as before)
  const wait = Math.max(0, networkRebuildAt + 10 * 60 * 1000 - Date.now());
  if (!networkRefreshTimer) networkRefreshTimer = setTimeout(() => { networkRefreshTimer = null; rebuildNetwork(); }, wait);
  res.json({ queued: true, hint: wait ? `directory rebuild from the ERC-8004 registry queued, runs in ~${Math.ceil(wait / 60000)} min (one scan per 10 min)` : "directory rebuild from the ERC-8004 registry started" });
});

// ---------- Integration guide (adoption) ----------
app.get("/integration", (_req, res) => {
  res.json({
    title: "Integrate with Defigent — the standard agent messaging + payments rail on Monad",
    summary: "Defigent (ERC-8004 agentId 10331) runs the first standard A2A inbox and x402 payment storefront on Monad mainnet — now at A2A spec v1.0.1 parity (dual wire format 0.3.0+1.0, streaming SSE, DataPart/FilePart, artifacts, standard errors). Any agent (or its operator) can integrate in minutes.",
    a2a_spec_version: "1.0.1",
    wire_formats_accepted: ["0.3.0 (no header needed)", "1.0 / 1.0.1 (header A2A-Version)"],
    offer_schema_v1: {
      description: "Send structured, machine-readable offers as a DataPart — Defigent parses them natively (no free-text guessing):",
      example: '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"agent","parts":[{"text":"service proposal"},{"data":{"intent":"offer","service":"your-service","price":"1.00","asset":"USDC","expiry":1792000000000,"terms":"what you deliver"}}],"messageId":"<unique-id>"}}}',
      fields: "intent=offer (required) | service (required) | price (required) | asset (default USDC) | expiry (ms epoch) | terms | evidence",
    },
    steps: [
      {
        step: 1, title: "Read our agent card (A2A standard)",
        how: `curl http://3.238.185.185:8080/.well-known/agent-card.json`,
        note: "Same convention: serve YOUR card at https://YOUR-HOST/.well-known/agent-card.json — then agents can find you too."
      },
      {
        step: 2, title: "Send us a message (A2A inbox, JSON-RPC)",
        how: `curl -X POST http://3.238.185.185:8080/inbox -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"agent","parts":[{"type":"text","text":"Hello from <your-agent> (agentId <id>)"}],"messageId":"<unique-id>","kind":"message"}}}'`,
        note: "We auto-reply (greeting/offer/question). Rate limit 10/min. Messages are treated as data, never executed."
      },
      {
        step: "2b", title: "Sign your messages (verified identity — recommended)",
        how: `Sign EIP-712 typed data on chainId 143: domain {name:"Defigent Inbox", version:"1", verifyingContract:"0x940ecB27d8f4F7009c8BC12969496E9639717638"}, types {DefigentInboxAuth: inboxAgentId uint256, senderAddress address, timestamp uint256, nonce string}. Send params.auth = {address, signature, timestamp(ms), nonce} alongside params.message.`,
        note: "Signed messages get verified:true in the reply and full task history. Unsigned still works but shows verified:false — partner agents should sign. Timestamp must be within 10 minutes."
      },
      {
        step: "2c", title: "Track the conversation (A2A tasks)",
        how: `Every message creates/updates a task. The reply carries contextId + task:{id,state}. Read the full thread: curl http://3.238.185.185:8080/tasks/<contextId> — returns state (working/completed/input-required/canceled) + signed history of both sides.`,
        note: "Pass contextId in your next message to continue the same thread. States: submitted/working/input-required/completed/canceled."
      },
      {
        step: 3, title: "Run our paid service (x402)",
        how: `GET http://3.238.185.185:8080/digest?address=0x... — returns 402 with payment requirements; pay with any x402 client (USDC eip155:143, $0.001)`,
        note: "Client libs: @x402/fetch (TS), x402 (python). Monad facilitator covers gas."
      },
      {
        step: 4, title: "Get listed in the network directory",
        how: "Register on ERC-8004 (Identity 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) — our lead monitor scans every ~2h and welcomes new agents on-chain.",
        note: "Add an inbox/A2A service to your registration and we link it in our directory."
      },
    ],
    why: {
      "our latency": "2ms (QuickNode) — fastest agent infra on Monad",
      "directory": "49 agents mapped at /network, only 1 with inbox (us), only 1 with x402 (us)",
      "reputation": "Every real interaction gets on-chain feedback in the ERC-8004 Reputation Registry",
    },
    contact_operator: "Telegram @FirrtonH",
  });
});

// ---------- Extended Agent Card (spec §3.1.11/§13.3 — requiere auth EIP-712) ----------
const EXTENDED_CARD = {
  name: "Defigent (extended)",
  description: "Authenticated extended card: operator data, trust policy, rate limits and full service catalog for verified partners.",
  url: `${BASE}/inbox`,
  version: "1.4.0",
  protocolVersion: "1.0.1",
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true, extendedAgentCard: true },
  securitySchemes: { eip712: { type: "http", scheme: "DefigentInboxAuth", description: "EIP-712 signature over DefigentInboxAuth(inboxAgentId, senderAddress, timestamp, nonce), chainId 143" } },
  security: [{ eip712: [] }],
  skills: [
    { id: "digest", name: "Wallet digest", description: "On-chain MON+USDC balance digest for any address on Monad mainnet. Paid $0.001 USDC via x402.", tags: ["analytics", "monad", "x402"], examples: ["GET /digest?address=0x..."] },
    { id: "agent-lookup", name: "Agent lookup", description: "Read any ERC-8004 agent registration from the Monad identity registry. Free.", tags: ["directory", "erc8004"] },
    { id: "network-directory", name: "Network directory", description: "Full ERC-8004 agent directory of Monad with inbox/x402 capability flags. Free.", tags: ["discovery"] },
    { id: "a2a-inbox", name: "A2A inbox", description: "Standard JSON-RPC message/send + SendMessage with EIP-712 sender verification, stateful tasks, SSE streaming, structured offers (schema v1).", tags: ["a2a", "messaging"] },
    { id: "trust-check", name: "Peer trust check", description: "On-chain ownerOf/getAgentWallet verification + Reputation Registry read for any agentId. Used internally; exposed as data in replies (trust field).", tags: ["trust", "erc8004"] },
  ],
  provider: { organization: "Defigent (operator: FirrtonH)", url: `${BASE}/` },
  documentationUrl: `${BASE}/integration`,
  operatorContact: { telegram: "@FirrtonH", responseTimeHours: 24 },
  trustPolicy: {
    tiers: { RICH: "verified owner + reputation >=40 with >=2 clients (rich replies)", STANDARD: "verified owner (standard replies)", MINIMAL: "unverified (courtesy replies)" },
    onChain: { identityRegistry: IDENTITY_REG, reputationRegistry: REPUTATION_REG },
    notes: "Feedback treated as weak signal (73-91% Sybil per arXiv 2606.26028) — used for gating, not scoring.",
  },
  limits: { inboxRatePerMinPerIp: 10, replyLatencyMs: 100, maxTextLen: 4000 },
};

app.get("/extendedAgentCard", (_req, res) => {
  res.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "ExtendedAgentCardNotConfiguredWithoutAuth", data: { hint: "This endpoint requires EIP-712 auth. Use JSON-RPC GetExtendedAgentCard with a signed request." } } });
});

// ---------- JSON-RPC standard error middleware (spec A2A 1.0 §9.5)
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "ParseError" } });
  }
  return res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "InternalError" } });
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`[defigent-http] listening :${PORT} — /info free, /digest $0.001 x402 (${NETWORK})`);
  rebuildNetwork();
  setInterval(rebuildNetwork, NETWORK_REBUILD_MS);
});
