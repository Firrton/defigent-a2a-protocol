// Typed jobs protocol v1: A2A 0.3 and 1.0 wire shapes for typed replies, JSON-RPC errors, extension header echo and SSE frames.
import { EXT_URI, fullKey } from "./protocol.mjs";

const STATE_1_0 = Object.freeze({
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  rejected: "TASK_STATE_REJECTED",
  failed: "TASK_STATE_FAILED",
  // R28: a peer's status or error keeps the task's previous state, which can be canceled.
  canceled: "TASK_STATE_CANCELED",
});

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const BAD_REQUEST = "type.googleapis.com/google.rpc.BadRequest";

// A missing A2A-Version header means 0.3 (A2A 1.0 rule); unsupported versions are rejected earlier by the server.
export function negotiateVersion(header) {
  return String(header ?? "").trim().startsWith("1.0") ? "1.0" : "0.3";
}

// The JSON-RPC `result` for a typed reply. taskId equals contextId. With name null the message carries only the text part.
export function typedResult({ version, contextId, state, name, body, text, messageId }) {
  // Never a reply without status.state: an unknown state is a bug, and the caller answers it as an internal error.
  if (!Object.hasOwn(STATE_1_0, state)) throw new Error(`typedResult: unknown task state ${JSON.stringify(state)}`);
  const timestamp = new Date().toISOString();
  const data = name === null ? null : { [fullKey(name)]: body };
  if (version === "1.0") {
    const parts = data ? [{ data, mediaType: "application/json" }, { text }] : [{ text }];
    const message = { messageId, contextId, taskId: contextId, role: "ROLE_AGENT", extensions: [EXT_URI], parts };
    return { task: { id: contextId, contextId, status: { state: STATE_1_0[state], timestamp, message } } };
  }
  const parts = data ? [{ kind: "data", data }, { kind: "text", text }] : [{ kind: "text", text }];
  const message = { kind: "message", messageId, contextId, taskId: contextId, role: "agent", extensions: [EXT_URI], parts };
  return { kind: "task", id: contextId, contextId, status: { state, timestamp, message } };
}

export function invalidParams({ id, field, detail }) {
  return rpcError(id, -32602, "Invalid params", [
    { "@type": BAD_REQUEST, fieldViolations: [{ field, description: detail }] },
    { "@type": ERROR_INFO, reason: "INVALID_TYPED_MESSAGE", domain: EXT_URI, metadata: { field } },
  ]);
}

export function chainUnavailable({ id }) {
  return rpcError(id, -32603, "Chain unavailable", [
    { "@type": ERROR_INFO, reason: "CHAIN_UNAVAILABLE", domain: EXT_URI, metadata: { retryable: "true" } },
  ]);
}

// An unexpected failure on the typed path: a JSON-RPC envelope, never the framework's HTML 500.
export function internalError({ id }) {
  return rpcError(id, -32603, "Internal error", [{ "@type": ERROR_INFO, reason: "INTERNAL", domain: EXT_URI, metadata: { retryable: "true" } }]);
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

// Echoes the activated extension on the header name the client used (A2A-Extensions for 1.0, X-A2A-Extensions for 0.3).
export function extensionsEcho(headers) {
  for (const name of ["A2A-Extensions", "X-A2A-Extensions"]) {
    const raw = headerValue(headers, name);
    if (raw !== undefined && String(raw).split(",").map((s) => s.trim()).includes(EXT_URI)) return { name, value: EXT_URI };
  }
  return null;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : headers[key];
}

export function sseFrame(rpcResponse) {
  return "data: " + JSON.stringify(rpcResponse) + "\n\n";
}
