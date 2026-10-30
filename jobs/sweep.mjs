// Periodic sweep of the typed jobs ledger. It verifies the operator's outbox claims on chain, follows the open jobs
// nobody messages us about (silent submits, expiries), and wakes the actions nobody has woken yet. Each item does its
// reads first and then writes in one transaction, so a chain failure halfway through an item leaves it untouched.
import { ChainUnavailable } from "./chain.mjs";
import { actionFor, handleAccept, handleDecline, handleJobMessage } from "./handlers.mjs";
import { parseJobDescription } from "./protocol.mjs";

const DAY_SECONDS = 86400;
const WAKE_BATCH = 20;
const TERMINAL = new Set(["Completed", "Rejected", "Expired"]);
// R32: a transition claim holds when the chain is at or past it; a terminal claim needs the exact terminal status.
const RANK = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 3, Expired: 3 };
const CLAIMED_STATUS = { funded: "Funded", completed: "Completed", rejected: "Rejected", expired: "Expired" };
// Reader calls each item makes before anything is known about it. A Submitted job adds the JobSubmitted lookup.
const JOB_READS = 3;
const CLAIM_READS = { decline: 0 };

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// A new action is inserted. An urgent one that is already pending replaces a non-urgent payload and is woken again,
// so a missed first wake does not cost the provider its pay at the evaluation deadline.
export function enqueueOrEscalate(store, action, contextId, now) {
  if (store.enqueueAction({ ...action, contextId, now })) return true;
  return action.payload?.urgent === true && store.escalateAction(action.key, action.payload, now);
}

class OutOfReads extends Error {}
class OfferTaken extends Error {}

// The reader, with every call counted against maxReads. A call over the budget throws before it reaches the chain.
function metered(reader, maxReads) {
  let left = maxReads;
  const call = (name) => (...args) => {
    if (left <= 0) throw new OutOfReads();
    left -= 1;
    return reader[name](...args);
  };
  return {
    left: () => left,
    getJob: call("getJob"),
    isBoundToAgent: call("isBoundToAgent"),
    hasPendingClaim: call("hasPendingClaim"),
    submittedDeliverable: call("submittedDeliverable"),
    blockTime: call("blockTime"),
  };
}

// The offer a created claim is about: named in the body (R5) or in the create_job action key it answers.
function createdOfferId(claim) {
  if (claim.body.offerId) return claim.body.offerId;
  const m = /^create_job:(of_[A-Za-z0-9]{10})$/.exec(claim.replyId ?? "");
  return m ? m[1] : null;
}

// Why job `jobId` is not the job our create_job made for `offer`, or null when it is.
function createdMismatch(job, offer, jobId, config) {
  if (!job) return `job ${jobId} does not exist on the escrow`;
  if (offer.jobId != null && offer.jobId !== jobId) return `offer ${offer.offerId} is already linked to job ${offer.jobId}`;
  if (!same(job.client, config.client)) return `job ${jobId} client ${job.client} is not ${config.client}`;
  if (offer.acceptedAddress == null) return `offer ${offer.offerId} has not been accepted`;
  if (!same(job.provider, offer.acceptedAddress)) return `job ${jobId} provider ${job.provider} is not the accepted address ${offer.acceptedAddress}`;
  if (job.providerAgentId !== BigInt(offer.acceptedAgentId))
    return `job ${jobId} provider agent ${job.providerAgentId} is not the accepted agent ${offer.acceptedAgentId}`;
  const d = parseJobDescription(job.description);
  if (!d || d.offerId !== offer.offerId || !same(d.terms, offer.termsHash)) return `job ${jobId} description does not point to offer ${offer.offerId} and its terms`;
  return null;
}

function statusMismatch(name, job, jobId) {
  const claimed = CLAIMED_STATUS[name];
  if (!job) return `job ${jobId} does not exist on the escrow`;
  if (TERMINAL.has(claimed)) return job.status === claimed ? null : `job ${jobId} is ${job.status} on chain, not ${claimed}`;
  return RANK[job.status] >= RANK[claimed] ? null : `job ${jobId} is ${job.status} on chain, not ${claimed} or later`;
}

export function sweepJobs({ store, reader, config, now, onAction, onTaskUpdate = () => {}, maxReads = 50, log = () => {} }) {
  const reads = metered(reader, maxReads);
  const result = { claims: [], actions: [], updates: [] };
  const fresh = [];

  function applyOp(op, contextId) {
    switch (op.op) {
      case "accept":
        if (!store.acceptOffer(op.offerId, op.address, op.agentId, contextId, now)) throw new OfferTaken(op.offerId);
        return;
      case "setOfferState":
        return store.setOfferState(op.offerId, op.state, now);
      case "setChainStatus":
        return store.setChainStatus(op.offerId, op.status, now);
      default:
        throw new Error(`jobs sweep: unknown ledger op ${JSON.stringify(op.op)}`);
    }
  }

  // The keys of the actions that were new, or pending ones that just turned urgent (design §6: evaluate urgente).
  // Callers keep them only once their transaction commits.
  function enqueue(actions, contextId) {
    return actions.filter((a) => enqueueOrEscalate(store, a, contextId, now)).map((a) => a.key);
  }

  // Writes the handler's ops and actions, the job bookkeeping and the claim verdict in one transaction.
  function commit({ out, offer, contextId, job = null, claim = null, extra = () => {} }) {
    const keys = store.transaction(() => {
      extra();
      for (const op of out.ops) applyOp(op, contextId);
      if (job && TERMINAL.has(job.status)) store.markJobTerminal(offer.offerId, now);
      if (claim) store.resolveClaim(claim.id, "verified", null, now);
      return enqueue(out.actions, contextId);
    });
    fresh.push(...keys);
    if (claim) result.claims.push({ id: claim.id, name: claim.name, state: "verified", reason: null });
  }

  function reject(claim, reason) {
    const review = actionFor({ kind: "review_claim", claimId: claim.id, claim: { name: claim.name, body: claim.body, reason } });
    const keys = store.transaction(() => {
      store.resolveClaim(claim.id, "rejected", reason, now);
      return enqueue([review], claim.contextId);
    });
    fresh.push(...keys);
    result.claims.push({ id: claim.id, name: claim.name, state: "rejected", reason });
    log(`jobs: claim ${claim.id} (${claim.name}) rejected: ${reason}`);
  }

  function update(contextId, out) {
    const u = { contextId, state: out.taskState, name: out.reply.name, body: out.reply.body, text: out.text };
    result.updates.push(u);
    try {
      onTaskUpdate(u);
    } catch (e) {
      log(`jobs: task update for ${contextId} failed: ${e?.message ?? e}`);
    }
  }

  async function verifyCreated(claim) {
    const jobId = claim.body.jobId;
    const offerId = createdOfferId(claim);
    const offer = offerId ? store.getOffer(offerId) : null;
    if (!offer) return reject(claim, offerId ? `offer ${offerId} is not in the ledger` : `the claim for job ${jobId} names no offer`);
    const job = await reads.getJob(BigInt(jobId));
    const reason = createdMismatch(job, offer, jobId, config);
    if (reason) return reject(claim, reason);
    // The sweep's open-jobs pass, which reads the pending claim, decides the job's actions.
    const out = handleJobMessage({ name: "created", msg: { jobId }, offer: { ...offer, jobId }, job, now, config });
    commit({ out: { ...out, actions: [] }, offer, contextId: offer.contextId, job, claim, extra: () => store.linkJob(offer.offerId, jobId, now) });
    update(offer.contextId, out);
  }

  async function verifyTransition(claim) {
    const jobId = claim.body.jobId;
    const offer = store.findOfferByJobId(jobId);
    if (!offer) return reject(claim, `job ${jobId} is not linked to any offer in the ledger`);
    const job = await reads.getJob(BigInt(jobId));
    const reason = statusMismatch(claim.name, job, jobId);
    if (reason) return reject(claim, reason);
    const out = handleJobMessage({ name: claim.name, msg: { jobId }, offer, job, now, config });
    commit({ out: { ...out, actions: [] }, offer, contextId: offer.contextId, job, claim });
    update(offer.contextId, out);
  }

  // The operator's verdict on an inbound offer runs through the same handlers as a peer's accept or decline.
  async function applyVerdict(claim) {
    const offer = store.getOffer(claim.body.offerId);
    let out;
    if (claim.name === "accept") {
      const { address, agentId } = claim.body.party;
      const bound = offer ? await reads.isBoundToAgent(address, BigInt(agentId)) : false;
      const counts = { createJobsToday: store.countActionsSince("create_job", now - DAY_SECONDS) };
      out = handleAccept({ msg: claim.body, offer, bound, now, config, counts, verdict: true });
    } else {
      out = handleDecline({ msg: claim.body, offer, now, verdict: true });
    }
    if (out.reply.name === "error") {
      // A retryable refusal (the daily create_job cap) leaves the claim pending for a later sweep.
      if (out.reply.body.retryable) return log(`jobs: claim ${claim.id} (${claim.name}) waits: ${out.reply.body.message}`);
      return reject(claim, out.reply.body.message);
    }
    try {
      commit({ out, offer, contextId: offer.contextId, claim });
    } catch (e) {
      if (!(e instanceof OfferTaken)) throw e;
      return reject(claim, `Offer ${e.message} was already accepted by another party.`);
    }
    update(offer.contextId, out);
  }

  async function sweepClaims() {
    for (const claim of store.pendingClaims(maxReads)) {
      // Claims go in order: a funded claim may depend on the created claim before it, so none is skipped.
      if (reads.left() < (CLAIM_READS[claim.name] ?? 1)) return;
      if (claim.name === "created") await verifyCreated(claim);
      else if (claim.name === "accept" || claim.name === "decline") await applyVerdict(claim);
      else if (Object.hasOwn(CLAIMED_STATUS, claim.name)) await verifyTransition(claim);
      else reject(claim, `${claim.name} is not a claim the sweep can verify`);
    }
  }

  async function sweepJob(offer) {
    const jobId = BigInt(offer.jobId);
    const [job, pendingClaim, chainNow] = await Promise.all([reads.getJob(jobId), reads.hasPendingClaim(jobId), reads.blockTime()]);
    if (!job) {
      log(`jobs: job ${offer.jobId} of offer ${offer.offerId} is not on the escrow`);
      store.markChecked(offer.offerId, now);
      return;
    }
    const deliverable = job.status === "Submitted" ? await reads.submittedDeliverable(jobId) : null;
    const out = handleJobMessage({ name: "query", msg: { jobId: offer.jobId }, offer, job, now: chainNow, config, pendingClaim, deliverable });
    commit({ out, offer, contextId: offer.contextId, job, extra: () => store.markChecked(offer.offerId, now) });
    if (offer.chainStatus !== job.status) update(offer.contextId, out);
  }

  async function sweepOpenJobs() {
    for (const offer of store.openJobOffers(maxReads)) {
      if (reads.left() < JOB_READS) return;
      await sweepJob(offer);
    }
  }

  function wake() {
    if (!onAction) return; // R3: without onAction the actions stay unwoken for a sweep that has one.
    for (const row of store.unwokenActions(WAKE_BATCH)) {
      try {
        onAction(row);
        store.markWoken(row.key, now);
      } catch (e) {
        log(`jobs: waking ${row.key} failed: ${e?.message ?? e}`);
      }
    }
  }

  const finish = () => {
    result.actions = fresh.map((k) => store.getAction(k));
    return result;
  };

  return (async () => {
    try {
      await sweepClaims();
      await sweepOpenJobs();
    } catch (e) {
      // The chain stopped answering: this round ends here with what it already committed.
      if (e instanceof ChainUnavailable) return finish();
      if (!(e instanceof OutOfReads)) throw e;
    }
    wake();
    return finish();
  })();
}
