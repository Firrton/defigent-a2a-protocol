// Typed jobs protocol v1: outbound A2A client. Builds a typed 0.3 message, sends it with message/send and pulls the
// defigent.job.* parts out of whatever the peer answers (0.3 Task or Message, 1.0 {task} or {message}).
import crypto from "node:crypto";
import { detectTyped, EXT_URI, fullKey } from "./protocol.mjs";

export function buildTypedMessage({ name, body, contextId, text, messageId = crypto.randomUUID() }) {
  return {
    kind: "message",
    messageId,
    role: "agent",
    contextId,
    extensions: [EXT_URI],
    parts: [{ kind: "data", data: { [fullKey(name)]: body } }, { kind: "text", text }],
  };
}

// Never throws: HTTP, JSON-RPC and network failures come back as { status, error }. status 0 means no HTTP answer.
// No A2A-Version header, so the peer reads the request as 0.3.
export async function sendTyped({ endpoint, message, fetchImpl = fetch, timeoutMs = 15000 }) {
  const request = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/send", params: { message } };
  // A ref'd timer (AbortSignal.timeout is unref'd) so a hung peer cannot let the process exit with the send pending.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`no answer from ${endpoint} within ${timeoutMs} ms (timed out)`)), timeoutMs);
  let res;
  let raw;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "A2A-Extensions": EXT_URI, "X-A2A-Extensions": EXT_URI },
      body: JSON.stringify(request),
      signal: abort.signal,
    });
    raw = await res.text();
  } catch (e) {
    return { status: res?.status ?? 0, error: { message: e?.message ?? String(e) } };
  } finally {
    clearTimeout(timer);
  }
  let rpc = null;
  try {
    rpc = JSON.parse(raw);
  } catch {
    // handled below
  }
  if (rpc?.error !== undefined) return { status: res.status, error: rpc.error };
  if (rpc && Object.hasOwn(rpc, "result")) return { status: res.status, result: rpc.result };
  return { status: res.status, error: { message: `HTTP ${res.status}: response is not JSON-RPC: ${raw.slice(0, 200)}` } };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// "agent" / "user" for both 0.3 ("agent") and 1.0 ("ROLE_AGENT") roles.
function roleOf(message) {
  return typeof message?.role === "string" ? message.role.toLowerCase().replace(/^role_/, "") : null;
}

// Typed parts of a peer's answer as { name, body, role, messageId }. Artifacts carry no role or messageId: they are the
// agent's output, so their role is "agent" and their messageId null. A message seen twice (status.message and history)
// counts once. Data parts without exactly one defigent.job.* key are skipped.
export function extractTyped(result) {
  if (!isPlainObject(result)) return [];
  const root = isPlainObject(result.task) ? result.task : isPlainObject(result.message) ? result.message : result;
  const sources = [];
  if (isPlainObject(root.status?.message)) sources.push({ message: root.status.message });
  for (const m of Array.isArray(root.history) ? root.history : []) if (isPlainObject(m)) sources.push({ message: m });
  for (const a of Array.isArray(root.artifacts) ? root.artifacts : []) if (isPlainObject(a)) sources.push({ parts: a.parts, role: "agent" });
  if (Array.isArray(root.parts)) sources.push({ message: root });

  const found = [];
  const seen = new Set();
  for (const { message, parts = message?.parts, role = roleOf(message) } of sources) {
    const messageId = typeof message?.messageId === "string" ? message.messageId : null;
    for (const part of Array.isArray(parts) ? parts : []) {
      if (!isPlainObject(part?.data)) continue;
      const detection = detectTyped([part.data]);
      if (detection.kind !== "typed") continue;
      if (messageId !== null) {
        const key = `${messageId}\n${detection.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      found.push({ name: detection.name, body: detection.body, role, messageId });
    }
  }
  return found;
}
