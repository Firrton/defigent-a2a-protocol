// Run: node --test network_directory.test.mjs   (no network: RPC, DNS and HTTP are injected)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  readDirectory, resolveDirectory, isPublicAddress, parseRegistration, fetchRegistration,
  httpsGetText, decodeAbiString, scanRegistry, rebuildDirectory,
} from "./network_directory.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "defigent-net-"));
const abiString = (s) => {
  const b = Buffer.from(s, "utf8");
  return "0x" + (32).toString(16).padStart(64, "0") + b.length.toString(16).padStart(64, "0") + b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0");
};
const dataUri = (obj) => "data:application/json;base64," + Buffer.from(JSON.stringify(obj)).toString("base64");
const revert = () => { throw new Error('{"code":3,"message":"execution reverted","data":"0x7e273289"}'); };
// fake registry: ids -> tokenURI; anything else reverts like ERC721NonexistentToken
const registry = (uris) => async (_to, data) => {
  const id = Number(BigInt("0x" + data.slice(10)));
  return id in uris ? abiString(uris[id]) : revert();
};
const agent = (agentId, extra = {}) => ({ agentId, name: "a" + agentId, inbox: null, x402: false, services: [], welcomeTx: null, status: "known", ...extra });

// ---------- what /network serves ----------
test("regression: a missing lead-monitor cache no longer empties the directory", () => {
  const dir = tmp(), seedFile = path.join(dir, "seed.json");
  fs.writeFileSync(seedFile, JSON.stringify({ updated: 5, agents: [agent(1), agent(2)] }));
  const d = resolveDirectory({ monitor: readDirectory(path.join(dir, "gone.json")), local: readDirectory(path.join(dir, "none.json")), seed: readDirectory(seedFile) });
  assert.equal(d.agents.length, 2);
  assert.equal(d.updated, 5);
});

test("readDirectory treats missing, corrupt, truncated and empty files as absent", () => {
  const dir = tmp(), f = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  assert.equal(readDirectory(path.join(dir, "missing.json")), null);
  assert.equal(readDirectory(f("corrupt.json", "{not json")), null);
  assert.equal(readDirectory(f("truncated.json", '{"updated":1,"agents":[{"agentId":1')), null);
  assert.equal(readDirectory(f("empty.json", '{"updated":1,"agents":[]}')), null);
  assert.equal(readDirectory(f("shape.json", '{"agents":{"1":{}}}')), null);
  assert.equal(readDirectory(f("ok.json", JSON.stringify({ updated: 1, agents: [agent(1)] }))).agents.length, 1);
});

test("resolveDirectory: nothing readable is an empty directory, not a crash", () => {
  assert.deepEqual(resolveDirectory({ monitor: null, local: null, seed: null }), { updated: 0, agents: [] });
});

test("resolveDirectory: the freshest of local and seed is the base", () => {
  const local = { updated: 10, agents: [agent(1)] }, seed = { updated: 20, agents: [agent(1), agent(2)] };
  assert.equal(resolveDirectory({ monitor: null, local, seed }).agents.length, 2);
  assert.equal(resolveDirectory({ monitor: null, local: { ...local, updated: 30 }, seed }).agents.length, 1);
});

test("resolveDirectory: the monitor cache only enriches (welcomeTx, status) and adds agents the scan lacks", () => {
  const local = { updated: 10, agents: [agent(1, { name: "chain-name" }), agent(2)] };
  const monitor = { updated: 99, agents: [agent(1, { name: "stale-name", welcomeTx: "0xabc", status: "welcomed" }), agent(7), { agentId: 2, status: "known" }] };
  const d = resolveDirectory({ monitor, local, seed: null });
  const byId = Object.fromEntries(d.agents.map((a) => [a.agentId, a]));
  assert.equal(byId[1].name, "chain-name");
  assert.equal(byId[1].welcomeTx, "0xabc");
  assert.equal(byId[1].status, "welcomed");
  assert.equal(byId[2].status, "known");
  assert.equal(byId[7].name, "a7");
  assert.equal(d.updated, 99);
  assert.equal(resolveDirectory({ monitor, local: null, seed: null }), monitor);
});

// ---------- registration files (third-party data) ----------
test("isPublicAddress rejects loopback, private, link-local, CGNAT and metadata ranges", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1", "fec0::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1",
    // forms that embed an internal IPv4: IPv4-compatible, 6to4, Teredo, NAT64; plus the documentation prefix
    "::127.0.0.1", "::7f00:1", "2002:7f00:1::", "2002:a9fe:a9fe::", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b::7f00:1", "2001:db8::1",
    "not-an-ip", ""]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.63.0.1", "3.238.185.185", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("parseRegistration maps an ERC-8004 registration to a directory entry", () => {
  const reg = { name: "  Defigent ", x402Support: true, services: [{ name: "x402", endpoint: "https://f.example" }, { name: "A2A", endpoint: "http://h/.well-known/agent-card.json" }, { name: "inbox", endpoint: "http://3.238.185.185:8080/inbox" }] };
  assert.deepEqual(parseRegistration(reg, "data:application/json;base64,e30="), { name: "Defigent", services: ["x402", "A2A", "inbox"], x402: true, inbox: "http://3.238.185.185:8080/inbox" });
  const viaUrl = parseRegistration({ name: "LP", endpoints: [{ name: "web" }] }, "https://chordsi.xyz/r.json");
  assert.deepEqual(viaUrl.services, ["https://chordsi.xyz/r.json", "web"]);
  assert.equal(viaUrl.x402, false);
});

test("parseRegistration survives hostile shapes", () => {
  const hostile = parseRegistration({ name: { a: 1 }, x402Support: "true", services: [null, 7, { name: 9 }, { name: "inbox", endpoint: "javascript:alert(1)" }, { name: "x".repeat(500) }] }, "ipfs://cid");
  assert.equal(hostile.name, null);
  assert.equal(hostile.x402, false);
  assert.equal(hostile.inbox, null);
  assert.deepEqual(hostile.services.map((s) => s.length), [5, 40]);
  assert.deepEqual(parseRegistration({ services: "nope" }, ""), { name: null, services: [], x402: false, inbox: null });
  assert.equal(parseRegistration({ name: "n".repeat(999) }, "").name.length, 120);
});

test("parseRegistration strips control and bidi characters and never publishes internal URLs", () => {
  const reg = parseRegistration({ name: "pay\u202Eeeb\u0000\u001b[31m me\u200b", services: [{ name: "in\u0007box" }, { name: "\u0000" }] }, "https://ok.example/r.json");
  assert.equal(reg.name, "payeeb[31m me");
  assert.deepEqual(reg.services, ["https://ok.example/r.json", "inbox"]);
  for (const endpoint of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080/inbox", "http://[::1]/inbox", "http://10.0.0.8/inbox", "http://user:pw@host.example/inbox",
    "http://localhost/inbox", "http://db.internal/inbox", "http://printer.local/inbox", "ftp://host.example/inbox"]) {
    assert.equal(parseRegistration({ services: [{ name: "inbox", endpoint }] }, "").inbox, null, endpoint);
  }
  assert.equal(parseRegistration({ services: [{ name: "Inbox", endpoint: "https://agent.example/a2a" }] }, "").inbox, "https://agent.example/a2a");
  for (const uri of ["https://user:pw@files.example/r.json", "http://192.168.1.10/r.json", "http://localhost/r.json"]) assert.deepEqual(parseRegistration({}, uri).services, [], uri);
});

test("fetchRegistration decodes data: URIs without touching the network", async () => {
  const boom = () => { throw new Error("network must not be used"); };
  assert.deepEqual(await fetchRegistration(dataUri({ name: "x" }), { lookup: boom, get: boom }), { name: "x" });
  assert.deepEqual(await fetchRegistration("data:application/json," + encodeURIComponent('{"name":"y"}'), { lookup: boom, get: boom }), { name: "y" });
  assert.equal(await fetchRegistration("data:text/html;base64,PGI+", { lookup: boom, get: boom }), null);
  assert.equal(await fetchRegistration(dataUri([1, 2]), { lookup: boom, get: boom }), null);
  assert.equal(await fetchRegistration("data:application/json;base64,bm90IGpzb24=", { lookup: boom, get: boom }), null);
});

test("fetchRegistration refuses anything that is not a vetted public https host", async () => {
  let gets = 0;
  const get = async () => { gets++; return '{"name":"leak"}'; };
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  for (const uri of ["http://example.com/r.json", "ipfs://bafy", "file:///etc/passwd", "https://169.254.169.254/latest/meta-data", "https://[::1]/r.json",
    "https://user:pw@example.com/r.json", "https://example.com:8443/r.json", "not a url", ""]) assert.equal(await fetchRegistration(uri, { lookup: pub, get }), null, uri);
  assert.equal(gets, 0);
  // hostname that resolves (even partly) to an internal address
  assert.equal(await fetchRegistration("https://rebind.example/r.json", { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }], get }), null);
  assert.equal(await fetchRegistration("https://meta.example/r.json", { lookup: async () => [{ address: "169.254.169.254", family: 4 }], get }), null);
  assert.equal(await fetchRegistration("https://nx.example/r.json", { lookup: async () => { throw new Error("ENOTFOUND"); }, get }), null);
  assert.equal(gets, 0);
});

test("fetchRegistration pins the connection to the address it vetted", async () => {
  const calls = [];
  const get = async (url, addrs) => { calls.push([url, addrs]); return '{"name":"ok"}'; };
  const vetted = [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }];
  const reg = await fetchRegistration("https://example.com/r.json", { lookup: async () => vetted, get });
  assert.deepEqual(reg, { name: "ok" });
  assert.deepEqual(calls, [["https://example.com/r.json", vetted]]);
  assert.equal(await fetchRegistration("https://example.com/r.json", { lookup: async () => [{ address: "93.184.216.34", family: 4 }], get: async () => null }), null);
  assert.equal(await fetchRegistration("https://example.com/r.json", { lookup: async () => [{ address: "93.184.216.34", family: 4 }], get: async () => "<html>" }), null);
});

test("httpsGetText connects only to the pinned address, follows no redirect, and caps size and time", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"name":"ok"}'); }
    else if (req.url === "/redirect") { res.writeHead(302, { location: "/ok" }); res.end(); }
    else if (req.url === "/big") { res.writeHead(200); res.end(Buffer.alloc(300 * 1024, 97)); }
    else { res.writeHead(200); res.write("{"); } // /stall: never finishes the body
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://pinned.invalid:${server.address().port}`, addrs = [{ address: "127.0.0.1", family: 4 }], opt = { transport: http, timeoutMs: 500 };
    // "pinned.invalid" does not resolve: the request only succeeds because DNS is bypassed by the pinned address
    assert.equal(await httpsGetText(base + "/ok", addrs, opt), '{"name":"ok"}');
    assert.equal(await httpsGetText(base + "/redirect", addrs, opt), null);
    assert.equal(await httpsGetText(base + "/big", addrs, opt), null);
    const t0 = Date.now();
    assert.equal(await httpsGetText(base + "/stall", addrs, opt), null);
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(await httpsGetText(`http://pinned.invalid:1/ok`, addrs, opt), null);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

// ---------- registry scan ----------
test("decodeAbiString reads a string return and rejects malformed data", () => {
  assert.equal(decodeAbiString(abiString("https://x.example/r.json")), "https://x.example/r.json");
  assert.equal(decodeAbiString(abiString("")), "");
  assert.equal(decodeAbiString("0x"), null);
  assert.equal(decodeAbiString("0x1234"), null);
  // declared length runs past the data
  assert.equal(decodeAbiString("0x" + (32).toString(16).padStart(64, "0") + (100).toString(16).padStart(64, "0") + "61".repeat(10).padEnd(64, "0")), null);
});

test("scanRegistry lists every id from the floor until the registry ends", async () => {
  const uris = { 100: dataUri({ name: "one", x402Support: true, services: [{ name: "inbox", endpoint: "https://one.example/inbox" }] }), 101: "https://files.example/two.json", 102: "ipfs://three", 103: "" };
  const d = await scanRegistry({ ethCall: registry(uris), firstId: 100, selfId: 100, now: 1000, fetchReg: async (uri) => (uri.startsWith("https://") ? { name: "two" } : uri.startsWith("data:") ? { name: "one", x402Support: true, services: [{ name: "inbox", endpoint: "https://one.example/inbox" }] } : null) });
  assert.deepEqual(d.agents.map((a) => [a.agentId, a.name, a.status]), [[100, "one", "verified-live"], [101, "two", "known"], [102, null, "known"], [103, null, "known"]]);
  assert.equal(d.agents[0].inbox, "https://one.example/inbox");
  assert.equal(d.agents[0].x402, true);
  assert.deepEqual(d.agents[1].services, ["https://files.example/two.json"]);
  assert.equal(d.updated, 1000);
});

test("scanRegistry tolerates a short gap but stops after consecutive missing ids", async () => {
  const d = await scanRegistry({ ethCall: registry({ 10: "", 11: "", 13: "", 20: "" }), firstId: 10, fetchReg: async () => null });
  assert.deepEqual(d.agents.map((a) => a.agentId), [10, 11, 13]);
});

test("scanRegistry re-reads a registration file at most daily and keeps the last good data when a host is down", async () => {
  const uris = { 5: "https://a.example/r.json", 6: "https://b.example/r.json", 7: "https://c.example/r.json" };
  let fetches = [];
  const first = await scanRegistry({ ethCall: registry(uris), firstId: 5, now: 1000, fetchReg: async (u) => { fetches.push(u); return { name: "n-" + u[8] }; } });
  assert.equal(fetches.length, 3);
  fetches = [];
  // one hour later: nothing changed, nothing is fetched
  const second = await scanRegistry({ ethCall: registry(uris), firstId: 5, previous: first, now: 1000 + 3600e3, fetchReg: async (u) => { fetches.push(u); return { name: "changed" }; } });
  assert.equal(fetches.length, 0);
  assert.deepEqual(second.agents.map((a) => a.name), ["n-a", "n-b", "n-c"]);
  // two days later every file is due; host b is down and its agent changed URI
  const third = await scanRegistry({ ethCall: registry({ ...uris, 7: "https://new.example/r.json" }), firstId: 5, previous: second, now: 1000 + 48 * 3600e3,
    fetchReg: async (u) => (u.includes("b.example") ? null : { name: "v2-" + u[8] }) });
  assert.deepEqual(third.agents.map((a) => a.name), ["v2-a", "n-b", "v2-n"]);
  assert.equal(third.agents[1]._ok, false);
});

test("scanRegistry aborts on an RPC failure instead of mistaking it for the end of the registry", async () => {
  const flaky = async (_to, data) => { const id = Number(BigInt("0x" + data.slice(10))); if (id === 3) throw new Error("fetch failed"); return abiString(""); };
  await assert.rejects(scanRegistry({ ethCall: flaky, firstId: 1, fetchReg: async () => null }), /registry read failed at agentId 3/);
  await assert.rejects(scanRegistry({ ethCall: async () => "0x", firstId: 1, fetchReg: async () => null }), /registry read failed/);
});

test("scanRegistry is bounded: a registry that never ends is cut at the cap, flagged, and reads a limited number of files", async () => {
  let fetches = 0;
  const d = await scanRegistry({ ethCall: async () => abiString("https://spam.example/r.json"), firstId: 1, fetchReg: async () => { fetches++; return null; } });
  assert.equal(d.agents.length, 1500);
  assert.equal(d.truncated, true);
  assert.ok(fetches <= 246, String(fetches));
  assert.equal((await scanRegistry({ ethCall: registry({ 1: "" }), firstId: 1, fetchReg: async () => null })).truncated, false);
});

// ---------- rebuild ----------
test("rebuildDirectory writes the directory atomically and reports what it did", async () => {
  const dir = tmp(), file = path.join(dir, "data", "network.json");
  const r = await rebuildDirectory({ ethCall: registry({ 1: "", 2: "" }), file, firstId: 1, fetchReg: async () => null });
  assert.deepEqual(r, { agents: 2, fetched: 2, truncated: false });
  assert.deepEqual(readDirectory(file).agents.map((a) => a.agentId), [1, 2]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["network.json"]);
});

test("rebuildDirectory never replaces a good directory with an empty or collapsed scan", async () => {
  const dir = tmp(), file = path.join(dir, "network.json");
  const good = { updated: 1, agents: [agent(1), agent(2), agent(3), agent(4), agent(5)] };
  fs.writeFileSync(file, JSON.stringify(good));
  await assert.rejects(rebuildDirectory({ ethCall: registry({}), file, firstId: 1, fetchReg: async () => null }), /scan returned 0 agents/);
  await assert.rejects(rebuildDirectory({ ethCall: registry({ 1: "", 2: "" }), file, firstId: 1, fetchReg: async () => null }), /scan returned 2 agents \(had 5\)/);
  // an RPC node that lags: the scan ends below the newest id we already knew
  await assert.rejects(rebuildDirectory({ ethCall: registry({ 1: "", 2: "", 3: "", 4: "" }), file, firstId: 1, fetchReg: async () => null }), /scan returned 4 agents \(had 5\) up to id 4/);
  await assert.rejects(rebuildDirectory({ ethCall: async () => { throw new Error("ECONNRESET"); }, file, firstId: 1, fetchReg: async () => null }), /registry read failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), good);
});

test("rebuildDirectory starts from the committed seed when there is no runtime file yet", async () => {
  const dir = tmp(), file = path.join(dir, "network.json"), seedFile = path.join(dir, "seed.json");
  const seeded = await scanRegistry({ ethCall: registry({ 1: "https://a.example/r.json" }), firstId: 1, now: Date.now(), fetchReg: async () => ({ name: "from-seed" }) });
  fs.writeFileSync(seedFile, JSON.stringify(seeded));
  const r = await rebuildDirectory({ ethCall: registry({ 1: "https://a.example/r.json", 2: "" }), file, seedFile, firstId: 1, fetchReg: async () => null });
  assert.deepEqual(r, { agents: 2, fetched: 1, truncated: false });
  assert.equal(readDirectory(file).agents[0].name, "from-seed");
});
