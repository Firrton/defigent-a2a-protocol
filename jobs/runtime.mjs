// Typed jobs runtime: runs one typed message through detection, idempotency, chain reads, the pure handlers and a
// single ledger transaction, and records the operator's outbox claims. The HTTP server and the scripts share it.
import { keccak256, toBytes } from "viem";
import { ChainUnavailable } from "./chain.mjs";
import { handleAccept, handleDecline, handleJobMessage, handleOffer } from "./handlers.mjs";
import { canonicalJson, detectTyped, fullKey, jobsJsonSchema, normalizeLegacyOffer, parseTyped } from "./protocol.mjs";
import { createJobsStore, migrateJobsStore } from "./store.mjs";
import { sweepJobs } from "./sweep.mjs";
import { adaptTextReply } from "./text_adapter.mjs";

const DAY_SECONDS = 86400;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// What the operator's outbox may claim: transitions it made on chain, and its verdicts on inbound offers.
const CLAIM_NAMES = new Set(["created", "funded", "completed", "rejected", "expired", "accept", "decline"]);

const hashOf = (value) => keccak256(toBytes(canonicalJson(value)));

// Pure: the operator claim an outbox line's `data` carries. null when data carries no single defigent.job.* key (not a typed line);
// otherwise { ok: true, name, body } for a valid claim, or { ok: false, name, reason } for a non-claim name or an invalid body.
export function parseClaim(data) {
  const detection = detectTyped([data]);
  if (detection.kind !== "typed") return null;
  const { name } = detection;
  if (!CLAIM_NAMES.has(name)) return { ok: false, name, reason: `${fullKey(name)} is not an operator claim` };
  const r = parseTyped(name, detection.body);
  if (!r.ok) return { ok: false, name, reason: `invalid ${fullKey(name)} claim: ${r.field || "body"} ${r.detail}` };
  return { ok: true, name, body: r.value };
}

// R12: a legacy offer has no offerId, so it gets one derived from its body; resending the same body hits the same natural key.
export function legacyOfferId(body) {
  let n = BigInt(hashOf(body));
  let id = "";
  for (let i = 0; i < 10; i += 1) {
    id += BASE62[Number(n % 62n)];
    n /= 62n;
  }
  return `of_${id}`;
}

function naturalKey(name, msg) {
  switch (name) {
    case "offer":
      return `offer:${msg.offerId}`;
    case "accept":
      return `accept:${msg.offerId}:${msg.party.address}:${msg.party.agentId}`;
    case "decline":
      return `decline:${msg.offerId}`;
    default:
      return null;
  }
}

function errorResult(code, message, field) {
  return { kind: "ok", name: "error", body: { code, message, ...(field === undefined ? {} : { field }), retryable: false }, text: message, taskState: "rejected", actions: [] };
}

const isError = (result) => result.name === "error";

// The same natural key with the same body repeats the stored answer; with another body it is a conflict.
function replayOrConflict(stored, hash, name, msg) {
  if (stored.bodyHash === hash) return stored.response;
  return errorResult("idempotency_conflict", `${fullKey(name)} for offer ${msg.offerId} was already received with different content.`, "offerId");
}

class OfferTaken extends Error {}

// One deadline for all the reads of a request: a reader method can make several RPC calls, each with its own timeout.
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ChainUnavailable(`no answer from the chain within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// onTaskUpdate is for the sweep, which reports changes nobody messaged us about.
export function createJobsRuntime({
  db, config, reader, clock = () => Math.floor(Date.now() / 1000), onAction, onTaskUpdate = () => {}, log = () => {},
}) {
  migrateJobsStore(db);
  const store = createJobsStore(db);
  const tasksTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'`);

  // R28: a peer's status or error leaves the A2A task where it was. The tasks table belongs to the HTTP server.
  function previousTaskState(contextId) {
    if (!tasksTable.get()) return null;
    return db.prepare(`SELECT state FROM tasks WHERE context_id=?`).get(contextId)?.state ?? null;
  }

  function parse(detection, now) {
    if (detection.kind === "legacy") {
      const r = normalizeLegacyOffer(detection.body, config, { newId: () => legacyOfferId(detection.body), now });
      // Hashing the original body keeps a resend stable even though the default expiry moves with `now`.
      return r.ok ? { ok: true, name: "offer", msg: r.value, hash: hashOf(detection.body) } : r;
    }
    const r = parseTyped(detection.name, detection.body);
    return r.ok ? { ok: true, name: detection.name, msg: r.value, hash: hashOf(r.value) } : r;
  }

  // Store state first, then the chain reads, then the pure handler. Nothing here writes.
  async function evaluate({ name, msg }, contextId, now) {
    if (name === "offer") {
      const existingOffer = store.getOffer(msg.offerId);
      const openOffersForAgent = msg.from ? store.countOpenOffersForAgent(msg.from.agentId, now) : 0;
      const tokenAllowed = await reader.isAllowedToken(msg.price.token);
      return { out: handleOffer({ msg, now, config, counts: { openOffersForAgent }, tokenAllowed, existingOffer }), actionContext: contextId };
    }
    if (name === "accept") {
      const offer = store.getOffer(msg.offerId);
      const createJobsToday = store.countActionsSince("create_job", now - DAY_SECONDS);
      const bound = await reader.isBoundToAgent(msg.party.address, BigInt(msg.party.agentId));
      return { out: handleAccept({ msg, offer, bound, now, config, counts: { createJobsToday } }), actionContext: contextId };
    }
    if (name === "decline") return { out: handleDecline({ msg, offer: store.getOffer(msg.offerId), now }), actionContext: contextId };

    // Transition notices and query. A query by offerId reads the job the offer is linked to.
    const offer = msg.jobId !== undefined ? store.findOfferByJobId(msg.jobId) : store.getOffer(msg.offerId);
    const jobId = msg.jobId ?? offer?.jobId ?? null;
    let job = null;
    let pendingClaim = false;
    let deliverable = null;
    let chainNow = now;
    if (jobId !== null) {
      job = await reader.getJob(BigInt(jobId));
      if (job) {
        [pendingClaim, chainNow, deliverable] = await Promise.all([
          reader.hasPendingClaim(job.jobId), reader.blockTime(), job.status === "Submitted" ? reader.submittedDeliverable(job.jobId) : null,
        ]);
      }
    }
    const out = handleJobMessage({ name, msg, offer, job, now: chainNow, config, pendingClaim, deliverable });
    const next = out.reply.body.next;
    if (job && next?.data) {
      const sim = await reader.simulate({ account: job.provider, to: next.to, data: next.data });
      next.simulation = sim.ok ? { ok: true } : { ok: false, reason: sim.reason };
    }
    // Job actions belong to the offer's task, where the peer polls.
    return { out, actionContext: offer?.contextId ?? contextId };
  }

  function applyOp(op, contextId, now) {
    switch (op.op) {
      case "insertOffer":
        return store.insertOffer({ ...op.row, contextId });
      case "accept":
        if (!store.acceptOffer(op.offerId, op.address, op.agentId, contextId, now)) throw new OfferTaken(op.offerId);
        return undefined;
      case "setOfferState":
        return store.setOfferState(op.offerId, op.state, now);
      case "setChainStatus":
        return store.setChainStatus(op.offerId, op.status, now);
      case "setDeliverable":
        return store.setDeliverable(op.offerId, op.deliverable, now);
      default:
        throw new Error(`jobs runtime: unknown ledger op ${JSON.stringify(op.op)}`);
    }
  }

  // R20: every outcome is remembered by messageId except retryable errors, which must be recomputed on retry.
  function remember(who, messageId, result, now) {
    if (messageId == null || (isError(result) && result.body.retryable === true)) return;
    store.rememberResponse(who, messageId, result, now);
  }

  // One transaction: ops, new actions, the natural-key reply (never an error) and the messageId memory.
  function commit({ parsed, key, out, actionContext, contextId, who, messageId, now }) {
    let result = { kind: "ok", name: out.reply.name, body: out.reply.body, text: out.text, taskState: out.taskState, actions: [] };
    const fresh = [];
    try {
      store.transaction(() => {
        // A concurrent request with the same key may have committed while this one read the chain.
        const stored = key ? store.getReply(key) : null;
        if (stored) {
          result = replayOrConflict(stored, parsed.hash, parsed.name, parsed.msg);
        } else {
          for (const op of out.ops) applyOp(op, contextId, now);
          for (const a of out.actions) if (store.enqueueAction({ ...a, contextId: actionContext, now })) fresh.push(a.key);
          if (key && !isError(result)) store.saveReply(key, parsed.hash, result, now);
        }
        remember(who, messageId, result, now);
      });
    } catch (e) {
      if (!(e instanceof OfferTaken)) throw e;
      // The ledger refused the accept (another party won the offer), so the whole transaction rolled back.
      result = errorResult("offer_taken", `Offer ${e.message} was already accepted by another party.`, "offerId");
      fresh.length = 0;
      remember(who, messageId, result, now);
    }

    const rows = fresh.map((k) => store.getAction(k));
    // R3: without onAction the actions stay unwoken, and the server's sweep wakes them.
    if (onAction) {
      for (const row of rows) {
        try {
          onAction(row);
          store.markWoken(row.key, clock());
        } catch (e) {
          log(`jobs: waking ${row.key} failed: ${e?.message ?? e}`);
        }
      }
    }
    return { ...result, actions: rows };
  }

  async function process({ detection, contextId, sender, messageId }) {
    if (detection?.kind !== "typed" && detection?.kind !== "legacy")
      return { kind: "invalid", field: detection?.field ?? "data", detail: detection?.detail ?? "no typed message" };
    const who = sender ?? "anon";
    const seen = messageId == null ? null : store.seenResponse(who, messageId);
    // The same (sender, messageId) again is a retry: the caller answers it but stores nothing new.
    if (seen) return { ...seen, replay: true };

    const now = clock();
    const parsed = parse(detection, now);
    if (!parsed.ok) {
      if (!parsed.unsupported) return { kind: "invalid", field: parsed.field, detail: parsed.detail };
      const result = errorResult("unsupported_key", `${fullKey(detection.name)} is not part of ${fullKey("*")} v1.`, fullKey(detection.name));
      remember(who, messageId, result, now);
      return result;
    }
    if (parsed.name === "status" || parsed.name === "error") {
      log(`jobs: ${parsed.name} from ${who} in ${contextId}`, parsed.msg);
      return { kind: "ok", name: null, body: null, text: "Received.", taskState: previousTaskState(contextId) ?? "completed", actions: [] };
    }

    const key = naturalKey(parsed.name, parsed.msg);
    const stored = key ? store.getReply(key) : null;
    if (stored) {
      const result = replayOrConflict(stored, parsed.hash, parsed.name, parsed.msg);
      remember(who, messageId, result, now);
      return result;
    }

    let evaluated;
    try {
      evaluated = await withDeadline(evaluate(parsed, contextId, now), config.rpcTimeoutMs);
    } catch (e) {
      if (e instanceof ChainUnavailable) return { kind: "chain_unavailable" };
      throw e;
    }
    return commit({ parsed, key, ...evaluated, contextId, who, messageId, now });
  }

  // Synchronous: it runs inside the outbox transaction. True when `data` is one valid claim (recorded once per replyId).
  function recordOperatorClaim({ contextId, replyId, data }) {
    const claim = parseClaim(data);
    if (!claim) return false;
    if (!claim.ok) {
      log(`jobs: no claim recorded in ${contextId}: ${claim.reason}`);
      return false;
    }
    store.recordClaim({ contextId, replyId, name: claim.name, body: claim.body, now: clock() });
    return true;
  }

  return {
    store,
    detect: detectTyped,
    parseClaim,
    adaptText: (text) => adaptTextReply(text, { findOffer: (id) => store.getOffer(id) }),
    process,
    recordOperatorClaim,
    sweep: () => sweepJobs({ store, reader, config, now: clock(), onAction, onTaskUpdate, log }),
    jsonSchema: jobsJsonSchema,
  };
}
