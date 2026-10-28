// Network directory behind GET /network: what to serve, and how to rebuild it from the on-chain ERC-8004 registry.
// The registry is the source of truth, so the directory no longer depends on a cache file someone else has to write.
// No dependencies. Also a CLI that regenerates the committed snapshot:  node network_directory.mjs data/network.seed.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const IDENTITY_REG = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const FIRST_ID = 10328;         // first agent the directory ever mapped; the scan runs from here to the newest id
const MAX_SCAN = 1500;                 // ids per rebuild, bounds RPC use (the result is flagged `truncated` when hit)
const MAX_FETCH = 240;                 // registration files read per rebuild; the rest are picked up by the next one
const MISS_LIMIT = 3;                  // consecutive nonexistent ids that end the scan
const BATCH = 6;
const REFETCH_MS = 24 * 3600_000;      // a registration file is re-read at most daily
const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 8000;
const REBUILD_DEADLINE_MS = 15 * 60_000;
export const RPC_PER_SEC = 20;         // registry reads per second: QuickNode refuses past 50/s (-32007), shared with the rest of the server
const READ_ATTEMPTS = 5;               // tries per registry read before the rebuild is aborted
const BACKOFF_MS = 500;                // wait after a failed read, doubled on every further try (0.5 + 1 + 2 + 4 s)

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), ms);
  p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hands out start times 1000/perSec ms apart, in the order callers ask, so concurrent reads never burst. Idle time earns
// no credit: a caller after a quiet spell starts at once, and the one right behind it still waits a full gap.
// Monotonic clock: a wall-clock step backwards must not turn into a long sleep.
export function pacer(perSec, { now = () => performance.now(), sleep = delay } = {}) {
  const gap = 1000 / perSec;
  let next = 0;
  return async () => {
    const t = now(), at = Math.max(t, next);
    next = at + gap;
    if (at > t) await sleep(at - t);
  };
}

// ---------- what /network serves ----------
// A directory file that is missing, corrupt, half-written or empty counts as absent. Parsed once per change (mtime).
const fileCache = new Map();
export function readDirectory(file) {
  let key;
  try { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch { fileCache.delete(file); return null; }
  const hit = fileCache.get(file);
  if (hit && hit.key === key) return hit.value;
  let value = null;
  try { const d = JSON.parse(fs.readFileSync(file, "utf8")); value = d && Array.isArray(d.agents) && d.agents.length ? d : null; } catch {}
  fileCache.set(file, { key, value });
  return value;
}

// Base = freshest of the runtime rebuild and the committed seed. The lead-monitor cache, when present, only
// enriches it (welcomeTx, status) and contributes agents the scan lacks; it can no longer blank the directory.
export function resolveDirectory({ monitor, local, seed }) {
  const base = [local, seed].filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
  if (!base) return monitor || { updated: 0, agents: [] };
  if (!monitor) return base;
  const byId = new Map(base.agents.map((a) => [String(a.agentId), a]));
  for (const m of monitor.agents) {
    if (!m || m.agentId == null) continue;
    const k = String(m.agentId), b = byId.get(k);
    byId.set(k, b ? { ...b, welcomeTx: m.welcomeTx || b.welcomeTx || null, status: m.status && m.status !== "known" ? m.status : b.status } : m);
  }
  return { updated: Math.max(base.updated || 0, monitor.updated || 0), agents: [...byId.values()] };
}

// ---------- registration files ----------
// tokenURI values come from anyone who registers an agent, so the server only ever reads them from public https hosts.
export function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  if (v === 6) {
    const s = ip.toLowerCase().split("%")[0], mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]);
    if (s.startsWith(":")) return false;
    // global unicast only (2000::/3), minus the ranges that can carry an internal IPv4 inside (Teredo and the other
    // 2001:0000::/23 protocol assignments, 6to4) and the documentation prefix
    const h = s.split(":"), a = parseInt(h[0], 16), b = h[1] ? parseInt(h[1], 16) : 0;
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
  }
  return false;
}

// Strings from registration files end up in a public JSON read by terminals, dashboards and LLMs.
const clean = (v, max) => String(v).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").trim().slice(0, max);

// An http(s) URL that is safe to publish: no credentials, no internal address or name.
function publicHttpUrl(v) {
  try {
    const u = new URL(String(v)), host = u.hostname.replace(/^\[|\]$/g, "");
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    if (net.isIP(host) ? !isPublicAddress(host) : /(^|\.)(localhost|local|internal)\.?$/i.test(host)) return null;
    return u.href.slice(0, 300);
  } catch { return null; }
}

export function parseRegistration(reg, uri) {
  const list = Array.isArray(reg.services) ? reg.services : Array.isArray(reg.endpoints) ? reg.endpoints : [];
  const named = list.filter((s) => s && typeof s.name === "string" && clean(s.name, 40));
  const inbox = named.map((s) => (clean(s.name, 40).toLowerCase() === "inbox" ? publicHttpUrl(s.endpoint) : null)).find(Boolean);
  const listed = publicHttpUrl(uri);
  return {
    name: (typeof reg.name === "string" && clean(reg.name, 120)) || null,
    services: [...(listed ? [listed] : []), ...named.slice(0, 12).map((s) => clean(s.name, 40))],
    x402: reg.x402Support === true || reg.x402support === true,
    inbox: inbox || null,
  };
}

// GET with the connection pinned to addresses that were already vetted (no DNS rebinding), no redirects, capped size
// and time. `transport` and `timeoutMs` exist for the tests.
export function httpsGetText(url, addrs, { transport = https, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let timer;
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const pinned = (_host, opts, cb) => (opts && opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family));
    const req = transport.get(url, { lookup: pinned, headers: { accept: "application/json", "user-agent": "defigent-directory/1.0" } }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); return done(null); }
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); done(null); } else chunks.push(c); });
      res.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => done(null));
    });
    timer = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
    req.on("error", () => done(null));
  });
}

// The registration JSON behind a tokenURI, or null when it cannot be read safely.
export async function fetchRegistration(uri, { lookup = dns.lookup, get = httpsGetText } = {}) {
  try {
    let text;
    if (/^data:/i.test(uri)) {
      const m = /^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.*)$/is.exec(uri);
      if (!m || uri.length > MAX_BYTES * 2) return null;
      text = m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
    } else {
      const u = new URL(uri);
      if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) return null;
      const addrs = await withTimeout(lookup(u.hostname, { all: true }), TIMEOUT_MS);
      if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) return null;
      text = await get(u.href, addrs);
    }
    const reg = typeof text === "string" ? JSON.parse(text) : null;
    return reg && typeof reg === "object" && !Array.isArray(reg) ? reg : null;
  } catch { return null; }
}

// ---------- registry scan ----------
const word = (n) => BigInt(n).toString(16).padStart(64, "0");

// ABI-encoded `string` return value, or null when the response is not one.
export function decodeAbiString(hex) {
  const raw = Buffer.from(String(hex).replace(/^0x/, ""), "hex");
  if (raw.length < 64) return null;
  const len = Number(raw.readBigUInt64BE(56));
  return 64 + len > raw.length ? null : raw.subarray(64, 64 + len).toString("utf8");
}

// tokenURI(id), or null when the id does not exist (the call reverts). Any other failure (a rate limit, an RPC hiccup)
// is retried with exponential backoff and then aborts the rebuild: it must never be mistaken for the end of the registry.
async function tokenUri(ethCall, id, { pace, sleep }) {
  for (let attempt = 0; ; attempt++) {
    try {
      await pace();
      const uri = decodeAbiString(await withTimeout(ethCall(IDENTITY_REG, "0xc87b56dd" + word(id)), TIMEOUT_MS));
      if (uri == null) throw new Error("malformed tokenURI response");
      return uri;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/revert/i.test(msg)) return null;
      if (attempt >= READ_ATTEMPTS - 1) throw new Error(`registry read failed at agentId ${id}: ${msg.slice(0, 120)}`);
      await sleep(BACKOFF_MS * 2 ** attempt);
    }
  }
}

// Every agent from firstId to the newest id. `previous` (the last directory) avoids re-reading registration files
// that have not changed and keeps the last good data for agents whose host is down. Registry reads are paced to
// RPC_PER_SEC: unpaced, a scan fires them as fast as the RPC answers and the provider starts refusing them.
export async function scanRegistry({ ethCall, firstId = FIRST_ID, previous = null, selfId = null, now = Date.now(), fetchReg = fetchRegistration,
  sleep = delay, pace = pacer(RPC_PER_SEC, { sleep }) }) {
  const prev = new Map(((previous && previous.agents) || []).map((a) => [Number(a.agentId), a]));
  const agents = [];
  let misses = 0, fetched = 0, ended = false;
  scan: for (let start = firstId; start < firstId + MAX_SCAN; start += BATCH) {
    const ids = Array.from({ length: BATCH }, (_, i) => start + i);
    const uris = await Promise.all(ids.map((id) => tokenUri(ethCall, id, { pace, sleep })));
    const entries = await Promise.all(ids.map(async (id, i) => {
      const uri = uris[i];
      if (uri == null) return null;
      const p = prev.get(id), tag = crypto.createHash("sha1").update(uri).digest("hex").slice(0, 16), same = !!p && p._uri === tag;
      const fresh = same && p._ok === true && now - (p._at || 0) < REFETCH_MS;
      let reg = null;
      if (!fresh && fetched < MAX_FETCH) { fetched++; reg = await fetchReg(uri); }
      const info = reg ? parseRegistration(reg, uri)
        : same ? { name: p.name ?? null, services: p.services || [], x402: !!p.x402, inbox: p.inbox || null }
        : parseRegistration({}, uri);
      return {
        agentId: id, name: info.name, inbox: info.inbox, x402: info.x402, services: info.services,
        welcomeTx: (p && p.welcomeTx) || null,
        status: id === selfId ? "verified-live" : p && p.status && p.status !== "verified-live" ? p.status : "known",
        _uri: tag, _at: reg ? now : fresh ? p._at : 0, _ok: !!reg || fresh,
      };
    }));
    for (const e of entries) {
      if (e) { misses = 0; agents.push(e); } else if (++misses >= MISS_LIMIT) { ended = true; break scan; }
    }
  }
  return { updated: now, agents, fetched, truncated: !ended };
}

const maxId = (d) => d.agents.reduce((m, a) => Math.max(m, Number(a.agentId) || 0), 0);

// Scan and persist. Agent ids never go away, so a scan that comes back empty, far smaller, or ending below the
// newest id we already had (an RPC node that lags) is a failed scan, never a reason to drop agents. The write is
// atomic so readers never see a half-written directory.
export async function rebuildDirectory({ ethCall, file, seedFile = null, selfId = null, firstId = FIRST_ID, fetchReg = fetchRegistration, pretty = false, sleep, pace }) {
  const previous = readDirectory(file) || (seedFile && readDirectory(seedFile)) || null;
  const next = await withTimeout(scanRegistry({ ethCall, firstId, previous, selfId, fetchReg, sleep, pace }), REBUILD_DEADLINE_MS);
  if (!next.agents.length || (previous && (next.agents.length < previous.agents.length / 2 || maxId(next) < maxId(previous)))) {
    throw new Error(`scan returned ${next.agents.length} agents (had ${previous ? previous.agents.length : 0}) up to id ${maxId(next)}, keeping the previous directory`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ updated: next.updated, agents: next.agents }, null, pretty ? 1 : 0));
  fs.renameSync(tmp, file);
  return { agents: next.agents.length, fetched: next.fetched, truncated: next.truncated };
}

// The key-bearing parts of an RPC URL (credentials, path segments, query values), masked wherever they show up.
const secretParts = (url) => {
  try {
    const u = new URL(url);
    return [u.username, u.password, ...u.pathname.split("/"), ...u.searchParams.values()].filter((p) => p.length >= 8);
  } catch { return []; }
};

// A rebuild failure as /status may show it, publicly: the RPC keys in `secrets`, any other URL and file paths are masked.
export const publicErrorText = (e, { secrets = [] } = {}) => {
  let text = String((e && e.message) || e);
  for (const part of secrets.flatMap(secretParts)) text = text.split(part).join("<secret>");
  return text.replace(/https?:\/\/[^\s"'<>]+/g, "<url>").replace(/(?<![\w.])(\/[\w.-]+){2,}/g, "<path>").slice(0, 200);
};

// How this process's rebuilds went, for /status. A failed rebuild keeps serving the last good directory, so without
// this only the journal shows that the directory stopped moving. The last failure is kept after a success: compare times.
export function rebuildTracker({ secrets = [], now = Date.now } = {}) {
  let lastOk = null, okAt = null, error = null;
  const iso = () => new Date(now()).toISOString();
  return {
    ok() { lastOk = true; okAt = iso(); },
    fail(e) { lastOk = false; error = { at: iso(), message: publicErrorText(e, { secrets }) }; },
    // `db` is the directory being served; a missing one or a bad `updated` reads as unknown instead of failing /status
    status(db) {
      const updated = new Date((db && db.updated) || NaN);
      return {
        updated_at: isNaN(updated) ? null : updated.toISOString(),
        agents: db && Array.isArray(db.agents) ? db.agents.length : null,
        last_rebuild_ok: lastOk,
        last_rebuild_ok_at: okAt,
        last_rebuild_error: error,
      };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] || "data/network.seed.json", RPC = process.env.RPC_URL || "https://rpc.monad.xyz";
  const ethCall = async (to, data) => {
    const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
    const j = await res.json();
    if (!j.result) throw new Error(JSON.stringify(j.error || j));
    return j.result;
  };
  rebuildDirectory({ ethCall, file: out, selfId: 10331, pretty: true })
    .then((r) => console.log(`${out}: ${r.agents} agents (${r.fetched} registration files read)${r.truncated ? " — scan cap reached" : ""}`))
    .catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
