import { test } from "node:test";
import assert from "node:assert/strict";
import { EXT_URI } from "./protocol.mjs";
import { chainUnavailable, extensionsEcho, internalError, invalidParams, negotiateVersion, sseFrame, typedResult } from "./wire.mjs";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("negotiateVersion maps an empty or 0.3 header to 0.3 and a 1.0 header to 1.0", () => {
  assert.equal(negotiateVersion(""), "0.3");
  assert.equal(negotiateVersion(undefined), "0.3");
  assert.equal(negotiateVersion("0.3"), "0.3");
  assert.equal(negotiateVersion("0.3.0"), "0.3");
  assert.equal(negotiateVersion("1.0"), "1.0");
  assert.equal(negotiateVersion(" 1.0.1 "), "1.0");
});

test("1.0 result wraps a task with TASK_STATE_* and ROLE_AGENT and no kind fields", () => {
  const r = typedResult({ version: "1.0", contextId: "c1", state: "input-required", name: "status", body: { next: null }, text: "t", messageId: "m" });
  assert.equal(r.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  assert.equal(r.task.status.message.role, "ROLE_AGENT");
  assert.deepEqual(r.task.status.message.parts[0], { data: { "defigent.job.status": { next: null } }, mediaType: "application/json" });
  assert.ok(!JSON.stringify(r).includes('"kind"'));
  assert.equal(r.task.id, "c1");
  assert.equal(r.task.contextId, "c1");
  assert.match(r.task.status.timestamp, ISO_RE);
  const { timestamp, ...status } = r.task.status;
  assert.deepEqual(status, {
    state: "TASK_STATE_INPUT_REQUIRED",
    message: {
      messageId: "m", contextId: "c1", taskId: "c1", role: "ROLE_AGENT", extensions: [EXT_URI],
      parts: [{ data: { "defigent.job.status": { next: null } }, mediaType: "application/json" }, { text: "t" }],
    },
  });
});

test("1.0 maps every task state to its TASK_STATE_ name", () => {
  const map = {
    working: "TASK_STATE_WORKING", "input-required": "TASK_STATE_INPUT_REQUIRED", completed: "TASK_STATE_COMPLETED", rejected: "TASK_STATE_REJECTED",
    failed: "TASK_STATE_FAILED", canceled: "TASK_STATE_CANCELED",
  };
  for (const [state, wire] of Object.entries(map)) {
    assert.equal(typedResult({ version: "1.0", contextId: "c", state, name: "status", body: {}, text: "t", messageId: "m" }).task.status.state, wire);
  }
});

test("0.3 result is the task itself with kind fields and lowercase state", () => {
  const r = typedResult({ version: "0.3", contextId: "c1", state: "completed", name: "accept", body: { offerId: "of_AbCdEf1234" }, text: "t", messageId: "m" });
  assert.equal(r.task, undefined);
  assert.match(r.status.timestamp, ISO_RE);
  const { timestamp, ...status } = r.status;
  assert.deepEqual({ ...r, status }, {
    kind: "task", id: "c1", contextId: "c1",
    status: {
      state: "completed",
      message: {
        kind: "message", messageId: "m", contextId: "c1", taskId: "c1", role: "agent", extensions: [EXT_URI],
        parts: [{ kind: "data", data: { "defigent.job.accept": { offerId: "of_AbCdEf1234" } } }, { kind: "text", text: "t" }],
      },
    },
  });
});

test("logged-only replies carry just the text part", () => {
  const r10 = typedResult({ version: "1.0", contextId: "c1", state: "completed", name: null, body: null, text: "logged", messageId: "m" });
  assert.deepEqual(r10.task.status.message.parts, [{ text: "logged" }]);
  const r03 = typedResult({ version: "0.3", contextId: "c1", state: "completed", name: null, body: null, text: "logged", messageId: "m" });
  assert.deepEqual(r03.status.message.parts, [{ kind: "text", text: "logged" }]);
});

test("invalidParams carries BadRequest and ErrorInfo with the extension domain", () => {
  assert.deepEqual(invalidParams({ id: 7, field: "amount", detail: "amount must be a base-unit decimal string" }), {
    jsonrpc: "2.0", id: 7,
    error: {
      code: -32602, message: "Invalid params",
      data: [
        { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "amount", description: "amount must be a base-unit decimal string" }] },
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INVALID_TYPED_MESSAGE", domain: EXT_URI, metadata: { field: "amount" } },
      ],
    },
  });
});

test("chainUnavailable is -32603 with CHAIN_UNAVAILABLE", () => {
  assert.deepEqual(chainUnavailable({ id: "r1" }), {
    jsonrpc: "2.0", id: "r1",
    error: {
      code: -32603, message: "Chain unavailable",
      data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CHAIN_UNAVAILABLE", domain: EXT_URI, metadata: { retryable: "true" } }],
    },
  });
  assert.equal(chainUnavailable({ id: undefined }).id, null);
});

test("extensionsEcho answers on either header name only when the URI is listed", () => {
  assert.deepEqual(extensionsEcho({ "a2a-extensions": `urn:other, ${EXT_URI}` }), { name: "A2A-Extensions", value: EXT_URI });
  assert.deepEqual(extensionsEcho({ "x-a2a-extensions": EXT_URI }), { name: "X-A2A-Extensions", value: EXT_URI });
  assert.deepEqual(extensionsEcho({ "A2A-Extensions": EXT_URI }), { name: "A2A-Extensions", value: EXT_URI });
  assert.equal(extensionsEcho({ "a2a-extensions": "urn:other" }), null);
  assert.equal(extensionsEcho({ "a2a-extensions": EXT_URI + "/extra" }), null);
  assert.equal(extensionsEcho({}), null);
  assert.equal(extensionsEcho(undefined), null);
});

test("sseFrame is one data line ended by a blank line", () => {
  const r = { jsonrpc: "2.0", id: 1, result: { a: "x\ny" } };
  assert.equal(sseFrame(r), "data: " + JSON.stringify(r) + "\n\n");
  assert.equal(sseFrame(r).split("\n").length, 3);
});

test("a peer's status into a canceled task (R28) keeps canceled in both versions; an unknown state throws", () => {
  const logged = { contextId: "c", state: "canceled", name: null, body: null, text: "Received.", messageId: "m" };
  assert.equal(typedResult({ version: "1.0", ...logged }).task.status.state, "TASK_STATE_CANCELED");
  assert.equal(typedResult({ version: "0.3", ...logged }).status.state, "canceled");
  for (const state of ["submitted", undefined, null, "TASK_STATE_WORKING"]) {
    assert.throws(() => typedResult({ version: "1.0", ...logged, state }), /unknown task state/);
    assert.throws(() => typedResult({ version: "0.3", ...logged, state }), /unknown task state/);
  }
});

test("internalError is a -32603 JSON-RPC envelope with an INTERNAL ErrorInfo", () => {
  assert.deepEqual(internalError({ id: 7 }), {
    jsonrpc: "2.0", id: 7,
    error: { code: -32603, message: "Internal error", data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INTERNAL", domain: EXT_URI, metadata: { retryable: "true" } }] },
  });
  assert.equal(internalError({}).id, null);
});
