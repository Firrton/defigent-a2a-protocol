import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTypedMessage, extractTyped, sendTyped } from "./a2a_client.mjs";
import { EXT_URI } from "./protocol.mjs";

const OFFER = { offerId: "of_AbCdEf1234", service: "a2a-conformance-probe" };
const ACCEPT = { offerId: "of_AbCdEf1234", party: { address: "0x940ecB27d8f4F7009c8BC12969496E9639717638", agentId: 10270 } };
const STATUS = { offerId: "of_AbCdEf1234", state: "open" };

test("buildTypedMessage uses the 0.3 shape and lists the extension", () => {
  const msg = buildTypedMessage({ name: "offer", body: OFFER, contextId: "of_AbCdEf1234", text: "An offer.", messageId: "m-1" });
  assert.deepEqual(msg, {
    kind: "message",
    messageId: "m-1",
    role: "user",
    contextId: "of_AbCdEf1234",
    extensions: [EXT_URI],
    parts: [{ kind: "data", data: { "defigent.job.offer": OFFER } }, { kind: "text", text: "An offer." }],
  });
  const fresh = buildTypedMessage({ name: "offer", body: OFFER, contextId: "c", text: "t" });
  assert.match(fresh.messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("sendTyped posts message/send with both extension headers and no version header", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { kind: "message", parts: [] } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const message = buildTypedMessage({ name: "offer", body: OFFER, contextId: "of_AbCdEf1234", text: "t", messageId: "m-1" });
  const out = await sendTyped({ endpoint: "https://peer.example/a2a", message, fetchImpl });

  assert.deepEqual(out, { status: 200, result: { kind: "message", parts: [] } });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://peer.example/a2a");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("A2A-Extensions"), EXT_URI);
  assert.equal(headers.get("X-A2A-Extensions"), EXT_URI);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.has("A2A-Version"), false);
  const rpc = JSON.parse(init.body);
  assert.equal(rpc.jsonrpc, "2.0");
  assert.equal(rpc.method, "message/send");
  assert.equal(typeof rpc.id, "string");
  assert.deepEqual(rpc.params, { message });
  assert.ok(init.signal instanceof AbortSignal);
});

test("sendTyped returns JSON-RPC errors, HTTP failures and network failures without throwing", async () => {
  const message = buildTypedMessage({ name: "offer", body: OFFER, contextId: "c", text: "t", messageId: "m-1" });
  const rpcError = { code: -32602, message: "Invalid params" };
  const asJson = (body, status) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await sendTyped({ endpoint: "https://p.example", message, fetchImpl: asJson({ jsonrpc: "2.0", id: 1, error: rpcError }, 200) }),
    { status: 200, error: rpcError });

  const html = await sendTyped({ endpoint: "https://p.example", message, fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 502 }) });
  assert.equal(html.status, 502);
  assert.match(html.error.message, /^HTTP 502: response is not JSON-RPC: <html>bad gateway<\/html>$/);

  const down = await sendTyped({ endpoint: "https://p.example", message, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(down, { status: 0, error: { message: "fetch failed" } });

  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const slow = await sendTyped({ endpoint: "https://p.example", message, fetchImpl: hang, timeoutMs: 20 });
  assert.equal(slow.status, 0);
  assert.match(slow.error.message, /timed out|timeout/i);
});

test("extractTyped finds typed parts in 0.3 tasks, 1.0 {task} results and plain messages", () => {
  const task03 = {
    kind: "task", id: "t", contextId: "c",
    status: { state: "working", message: { kind: "message", messageId: "a-2", role: "agent", parts: [{ kind: "data", data: { "defigent.job.accept": ACCEPT } }, { kind: "text", text: "ok" }] } },
    history: [
      { kind: "message", messageId: "u-1", role: "user", parts: [{ kind: "data", data: { "defigent.job.offer": OFFER } }] },
      { kind: "message", messageId: "a-2", role: "agent", parts: [{ kind: "data", data: { "defigent.job.accept": ACCEPT } }] },
    ],
    artifacts: [{ artifactId: "x", parts: [{ kind: "data", data: { "defigent.job.status": STATUS } }] }],
  };
  assert.deepEqual(extractTyped(task03), [
    { name: "accept", body: ACCEPT, role: "agent", messageId: "a-2" },
    { name: "offer", body: OFFER, role: "user", messageId: "u-1" },
    { name: "status", body: STATUS, role: "agent", messageId: null },
  ]);

  const task10 = {
    task: {
      id: "t", contextId: "c",
      status: { state: "TASK_STATE_COMPLETED", message: { messageId: "a-9", role: "ROLE_AGENT", parts: [{ data: { "defigent.job.status": STATUS }, mediaType: "application/json" }, { text: "s" }] } },
      history: [{ messageId: "u-9", role: "ROLE_USER", parts: [{ data: { "defigent.job.offer": OFFER } }] }],
    },
  };
  assert.deepEqual(extractTyped(task10), [
    { name: "status", body: STATUS, role: "agent", messageId: "a-9" },
    { name: "offer", body: OFFER, role: "user", messageId: "u-9" },
  ]);

  const message03 = { kind: "message", messageId: "a-3", role: "agent", parts: [{ kind: "data", data: { "defigent.job.decline": { offerId: "of_AbCdEf1234", reason: "price" } } }] };
  assert.deepEqual(extractTyped(message03), [{ name: "decline", body: { offerId: "of_AbCdEf1234", reason: "price" }, role: "agent", messageId: "a-3" }]);
  const message10 = { message: { messageId: "a-4", role: "ROLE_AGENT", parts: [{ data: { "defigent.job.accept": ACCEPT } }] } };
  assert.deepEqual(extractTyped(message10), [{ name: "accept", body: ACCEPT, role: "agent", messageId: "a-4" }]);

  assert.deepEqual(extractTyped(null), []);
  assert.deepEqual(extractTyped(undefined), []);
});

test("extractTyped ignores data parts without defigent.job keys", () => {
  const result = {
    kind: "message", messageId: "a-5", role: "agent",
    parts: [
      { kind: "data", data: { intent: "offer", service: "x", price: "1" } },
      { kind: "data", data: { "other.ns.offer": OFFER } },
      { kind: "data", data: { "defigent.job.accept": ACCEPT, "defigent.job.decline": { offerId: "of_AbCdEf1234", reason: "price" } } },
      { kind: "data", data: ["defigent.job.accept"] },
      { kind: "text", text: "defigent.job.accept of_AbCdEf1234" },
      { kind: "file", file: { uri: "https://x.example/f" } },
    ],
  };
  assert.deepEqual(extractTyped(result), []);
});
