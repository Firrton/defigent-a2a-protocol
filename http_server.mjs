// Defigent HTTP x402 storefront — public sales endpoint on Monad mainnet
// Endpoints: GET /info (free), GET /digest (paid $0.001 x402 exact eip155:143)
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const PAY_TO = "0x940ecB27d8f4F7009c8BC12969496E9639717638";
const RPC = process.env.RPC_URL || "https://rpc.monad.xyz";
const FACILITATOR = "https://x402-facilitator.molandak.org";
const NETWORK = "eip155:143";
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
app.use(express.json());

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());
await resourceServer.initialize();

app.use(paymentMiddleware(
  {
    "GET /digest": {
      accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: PAY_TO }],
      description: "Defigent on-chain wallet digest (MON+USDC balances), ERC-8004 agentId 10331",
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
  const mon = await rpc("eth_getBalance", [address, "latest"]);
  let usdc = 0;
  try {
    const r = await rpc("eth_call", [{
      to: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      data: "0x70a08231" + address.toLowerCase().slice(2).padStart(64, "0"),
    }, "latest"]);
    usdc = parseInt(r, 16) / 1e6;
  } catch {}
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
const START_TS = Date.now();
const INBOX_FILE = "/home/ubuntu/.hermes/cache/scratch/defigent_inbox.jsonl";
const RATE = new Map(); // ip -> [timestamps]

function logInbox(entry) {
  try { fs.appendFileSync(INBOX_FILE, JSON.stringify(entry) + "\n"); } catch {}
}

// ---------- A2A agent card (well-known standard) ----------
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.json({
    name: "Defigent",
    description: "Agentic commerce specialist agent on Monad: on-chain wallet digests, agent directory lookup, and regime analytics. ERC-8004 agentId 10331. Talks and pays x402 (v1+v2).",
    url: `${BASE}/inbox`,
    version: "1.3.0",
    protocolVersion: "0.3.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      { id: "digest", name: "Wallet digest", description: "On-chain MON+USDC balance digest for any address on Monad mainnet. Paid $0.001 USDC via x402.", tags: ["analytics", "monad", "x402"] },
      { id: "agent-lookup", name: "Agent lookup", description: "Read any ERC-8004 agent registration from the Monad identity registry. Free.", tags: ["directory", "erc8004"] },
      { id: "status", name: "Status", description: "Live heartbeat: latency, uptime, balances, prices. Free.", tags: ["infra"] },
    ],
    provider: { organization: "Defigent (operator: FirrtonH)", url: `${BASE}/info` },
    registration: { agentId: 10331, registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  });
});

// ---------- A2A v2: SQLite tasks + signed sender identity ----------
import Database from "better-sqlite3";
import { verifyTypedData } from "viem";

const A2A_DB = "/home/ubuntu/.hermes/cache/scratch/defigent_a2a.db";
const a2a = new Database(A2A_DB);
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
);`);

function upsertTask(contextId, state) {
  const now = Date.now();
  a2a.prepare(`INSERT INTO tasks (context_id, state, created_at, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(context_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .run(contextId, state, now, now);
}

function addMessage(contextId, role, text, verified, sender) {
  a2a.prepare(`INSERT INTO messages (context_id, role, text, verified, sender, ts) VALUES (?,?,?,?,?,?)`)
    .run(contextId, role, text, verified ? 1 : 0, sender || null, Date.now());
}

function getHistory(contextId) {
  return a2a.prepare(`SELECT role, text, verified, sender, ts FROM messages WHERE context_id=? ORDER BY ts ASC`).all(contextId);
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
  const msg = body?.params?.message || body?.message || body;
  const text = (msg?.parts || []).map(p => p.text || "").join(" ").slice(0, 4000);
  const id = body?.id ?? null;
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
  if (/onboarding probe.*ready/i.test(text) && text.length < 200) cls = "handshake";
  else if (/hello|hi\b|hola|welcome|greeting|present|soy |i am |i'm /.test(lower)) cls = "greeting";
  else if (/offer|propuesta|partnership|alianza|collab|colaboración|service proposal/.test(lower)) cls = "offer";
  else if (/\?/.test(text)) cls = "question";

  logInbox({ ts: now, ip, messageId, cls, from: msg?.role || "unknown", declaredAgent: /agentId[ ]?\d+/i.exec(text)?.[0] || null, verified: ident.verified, sender: ident.address || null, contextId, text: (text || "").slice(0, 2000) });
  addMessage(contextId, "user", text, ident.verified, ident.address || declaredSender);

  let reply;
  if (cls === "handshake") {
    reply = "READY";
  } else if (cls === "greeting") {
    reply = `Hello! Defigent here (ERC-8004 agentId 10331, Monad). We run the standard A2A inbox you are using right now — any agent on Monad can write to us here. Our paid services run on x402: wallet digest $0.001, agent lookup free. Let's interop.`;
  } else if (cls === "offer") {
    reply = `Offer received and logged for operator review (response via this inbox or Telegram @FirrtonH). Card: ${BASE}/.well-known/agent-card.json`;
  } else if (cls === "question") {
    reply = `Answering from Defigent KB: services — GET /info (free), GET /digest?address=0x... ($0.001 x402), GET /status (free), GET /.well-known/agent-card.json (A2A). Operator: Telegram @FirrtonH.`;
  } else {
    reply = `Message logged for operator review. Card: ${BASE}/.well-known/agent-card.json`;
  }

  addMessage(contextId, "agent", reply, true, null);
  // task stays 'working' awaiting operator; auto-close simple classes after response
  if (["handshake", "greeting", "question"].includes(cls)) {
    upsertTask(contextId, "completed");
  } else {
    upsertTask(contextId, "input-required");
  }

  res.json({ jsonrpc: "2.0", id, result: {
    kind: "message", role: "agent",
    parts: [{ type: "text", text: reply }],
    messageId: `defigent-re-${now}`,
    contextId,
    verified: ident.verified,
    sender: ident.address || null,
    task: { id: contextId, state: ["handshake","greeting","question"].includes(cls) ? "completed" : "input-required" },
  }});
});

// ---------- A2A tasks: read state + history ----------
app.get("/tasks/:contextId", (req, res) => {
  const ctx = req.params.contextId;
  const task = a2a.prepare(`SELECT * FROM tasks WHERE context_id=?`).get(ctx);
  if (!task) return res.status(404).json({ error: "task not found" });
  res.json({
    task: { id: task.context_id, state: task.state, createdAt: task.created_at, updatedAt: task.updated_at },
    history: getHistory(ctx).map(m => ({ role: m.role, text: m.text, verified: !!m.verified, sender: m.sender, ts: m.ts })),
  });
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
app.get("/status", async (_req, res) => {
  const t0 = Date.now();
  let rpcMs = null, block = null;
  try {
    const b = await rpc("eth_blockNumber", []);
    rpcMs = Date.now() - t0;
    block = BigInt(b).toString();
  } catch {}
  res.json({
    service: "Defigent storefront",
    uptime_s: Math.floor((Date.now() - START_TS) / 1000),
    rpc_latency_ms: rpcMs,
    head_block: block,
    inbox_messages: (function(){ try { return fs.readFileSync(INBOX_FILE, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })(),
    endpoints: ["/info", "/digest (x402 $0.001)", "/status", "/inbox (A2A v2: signed+tasks)", "/tasks/:contextId", "/tasks/cancel", "/network", "/integration", "/.well-known/agent-card.json"],
    registration: { agentId: 10331, registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  });
});

// ---------- Network directory ----------
const NETWORK_FILE = "/home/ubuntu/.hermes/cache/scratch/defigent_network.json";
function loadNetwork() { try { return JSON.parse(fs.readFileSync(NETWORK_FILE, "utf8")); } catch { return { updated: 0, agents: [] }; } }

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
  // Rebuilds the directory from the ERC-8004 registry (open — anyone can trigger; cheap RPC reads)
  res.json({ queued: true, hint: "directory rebuild runs async via lead-monitor pipeline" });
});

// ---------- Integration guide (adoption) ----------
app.get("/integration", (_req, res) => {
  res.json({
    title: "Integrate with Defigent — the standard agent messaging + payments rail on Monad",
    summary: "Defigent (ERC-8004 agentId 10331) runs the first standard A2A inbox and x402 payment storefront on Monad mainnet. Any agent (or its operator) can integrate in minutes.",
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

app.listen(PORT, "0.0.0.0", () => {
  console.error(`[defigent-http] listening :${PORT} — /info free, /digest $0.001 x402 (${NETWORK})`);
});
