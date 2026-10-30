// Pure handlers for the typed jobs protocol: each takes the message, the stored state and the chain reads, and
// returns the reply, the A2A task state, the operator actions and the ledger ops. No I/O.
import { zeroAddress } from "viem";
import { tokenByAddress } from "./config.mjs";
import { nextStep, offerNext, taskStateFor } from "./next.mjs";
import { jobDescription, termsHash } from "./protocol.mjs";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function fail(code, message, field, retryable = false) {
  const body = { code, message, ...(field === undefined ? {} : { field }), retryable };
  return { reply: { name: "error", body }, text: message, taskState: "rejected", actions: [], ops: [] };
}

function status({ offer = null, job = null, next, deliverable = null, actions = [], ops = [] }) {
  return {
    reply: { name: "status", body: statusBody({ offer, job, next, deliverable }) },
    text: next.note,
    taskState: taskStateFor({ next, job, offer }),
    actions,
    ops,
  };
}

// The deliverable reference for a job: the hash read from JobSubmitted (verified) or the stored notice (unverified).
// A stored notice only adds its uri and mediaType when its hash matches the chain.
function deliverableRef(chainHash, stored) {
  if (chainHash) return { ...(same(stored?.hash, chainHash) ? stored : {}), hash: chainHash, verified: true };
  return stored ? { ...stored, verified: false } : null;
}

export function statusBody({ offer, job, next, deliverable = null }) {
  const body = {};
  if (offer) body.offer = { offerId: offer.offerId, state: offer.state };
  if (job) {
    body.job = {
      jobId: job.jobId.toString(),
      chainStatus: job.status,
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      budget: { amount: job.budget.toString(), token: job.paymentToken === zeroAddress ? null : job.paymentToken },
      expiresAt: job.expiredAt,
      submittedAt: job.submittedAt || null,
      deliverable,
    };
  }
  body.next = next;
  return body;
}

// The money-moving actions need the step to be ours and to be exactly that action.
const ours = (next, action) => next?.ours === true && next.action === action;

export function actionFor({ kind, next, job, offer, deliverable = null, config, claimId, claim }) {
  const make = (id, payload) => ({ key: `${kind}:${id}`, action: kind, payload });
  switch (kind) {
    case "review_offer": {
      // Everything the operator approves with an accept: the job's terms, its expiry and what the peer asks for gas.
      const t = offer.terms;
      return make(offer.offerId, {
        offerId: offer.offerId, side: t.side, service: t.service, description: t.description, price: t.price, deliverable: t.deliverable,
        gas: t.gas ?? null, from: t.from ?? null, to: t.to ?? null, expiresAt: t.expiresAt,
      });
    }
    case "create_job": {
      if (!ours(next, "create_job")) return null;
      const t = offer.terms;
      return make(offer.offerId, {
        offerId: offer.offerId, provider: offer.acceptedAddress, agentId: offer.acceptedAgentId, evaluator: config.evaluator, hook: config.hook,
        expiredAt: offer.expiresAt, description: jobDescription(t), token: t.price.token, amount: t.price.amount,
      });
    }
    case "gas_grant": {
      // Only our own outbound offers grant gas: an inbound offer's gas.grant is chosen by the peer and is never paid.
      const grant = offer.terms.gas?.grant;
      if (offer.direction !== "out" || !grant || !ours(next, "create_job")) return null;
      return make(offer.offerId, { to: offer.acceptedAddress, amountWei: grant });
    }
    case "fund":
      if (!ours(next, "fund")) return null;
      return make(job.jobId.toString(), { jobId: job.jobId.toString(), token: job.paymentToken, amount: job.budget.toString() });
    case "evaluate":
      // Roles in v1: only a job Defigent created as the client (next.ours checks it as well).
      if (!ours(next, "evaluate") || !same(job.client, config.client)) return null;
      return make(job.jobId.toString(), {
        jobId: job.jobId.toString(), offerId: offer?.offerId ?? null, client: job.client, deadline: next.deadline, urgent: next.urgent,
        deliverable: deliverableRef(deliverable, offer?.deliverable),
      });
    case "refund":
      if (!ours(next, "refund")) return null;
      return make(job.jobId.toString(), { jobId: job.jobId.toString() });
    case "review_claim":
      return make(claimId, { claimId, name: claim.name, body: claim.body, reason: claim.reason });
    default:
      return null;
  }
}

const present = (...xs) => xs.filter((x) => x !== null);

export function handleOffer({ msg, now, config, counts: { openOffersForAgent }, tokenAllowed, existingOffer = null }) {
  const id = msg.offerId;
  if (existingOffer) {
    if (existingOffer.termsHash !== termsHash(msg)) return fail("idempotency_conflict", `Offer ${id} already exists with different terms.`, "offerId");
    return status({ offer: existingOffer, next: offerNext(existingOffer, now) });
  }
  if (now >= msg.expiresAt) return fail("offer_expired", `Offer ${id} expired at ${msg.expiresAt}.`, "expiresAt");
  if (!same(msg.settlement.escrow, config.escrow))
    return fail("unsupported_terms", `Offer ${id} settles on escrow ${msg.settlement.escrow}; Defigent only uses ${config.escrow}.`, "settlement.escrow");
  const token = tokenByAddress(config, msg.price.token);
  if (!tokenAllowed || !token) return fail("unsupported_terms", `Token ${msg.price.token} is not accepted for payment.`, "price.token");
  // The operator judges the price from decimals and symbol, so they must be the configured token's.
  if (msg.price.decimals !== token.decimals)
    return fail("unsupported_terms", `Token ${token.address} has ${token.decimals} decimals, not ${msg.price.decimals}.`, "price.decimals");
  if (msg.price.symbol !== token.symbol)
    return fail("unsupported_terms", `Token ${token.address} is ${token.symbol}, not ${JSON.stringify(msg.price.symbol)}.`, "price.symbol");
  if (BigInt(msg.price.amount) > config.caps.maxOfferAmount)
    return fail("unsupported_terms", `Amount ${msg.price.amount} exceeds the cap of ${config.caps.maxOfferAmount} base units.`, "price.amount");
  if (openOffersForAgent >= config.caps.maxOpenOffersPerAgent)
    return fail("capacity_exceeded", `${msg.from ? `Agent ${msg.from.agentId}` : "The sender"} already has ${openOffersForAgent} open offers. Retry once one is settled.`, "from.agentId", true);

  // contextId is the request's, so the runtime adds it; peerEndpoint is never taken from replyTo.url (R9).
  const row = {
    offerId: id, direction: "in", peerAgentId: msg.from?.agentId ?? null, peerAddress: msg.from?.address ?? null, peerEndpoint: null,
    terms: msg, termsHash: termsHash(msg), state: "under_review", expiresAt: msg.expiresAt, createdAt: now,
  };
  return status({
    offer: row, next: offerNext(row, now), actions: [actionFor({ kind: "review_offer", offer: row, config })], ops: [{ op: "insertOffer", row }],
  });
}

// A peer accepts or declines one of our offers. With `verdict`, the operator answers an inbound offer's review_offer
// instead (the sweep, from an outbox claim): the offer is inbound, its `to` names us, and the party is its sender.
export function handleAccept({ msg, offer, bound, now, config, counts: { createJobsToday }, verdict = false }) {
  const id = msg.offerId;
  const { address, agentId } = msg.party;
  if (!offer || offer.direction !== (verdict ? "in" : "out")) return fail("unknown_offer", `Unknown offer ${id}.`, "offerId");
  if (offer.state === "accepted") {
    if (same(offer.acceptedAddress, address) && offer.acceptedAgentId === agentId) return status({ offer, next: offerNext(offer, now) });
    return fail("offer_taken", `Offer ${id} was already accepted by another party.`, "offerId");
  }
  if (offer.state === "declined") return fail("state_mismatch", `Offer ${id} was declined and cannot be accepted.`, "offerId");
  if (offer.state === "expired" || now >= offer.expiresAt) return fail("offer_expired", `Offer ${id} expired at ${offer.expiresAt}.`, "offerId");
  if (offer.expiresAt - now < config.minWorkWindowSeconds)
    return fail("offer_expired", `Offer ${id} expires at ${offer.expiresAt}, less than ${config.minWorkWindowSeconds} s from now.`, "offerId");
  const to = offer.terms.to?.agentId;
  if (!verdict && to !== undefined && to !== agentId) return fail("identity_mismatch", `Offer ${id} is addressed to agent ${to}, not ${agentId}.`, "party.agentId");
  // Plan decision 1: the verdict supplies the provider's identity only when the offer did not bring one.
  const from = offer.terms.from?.agentId;
  if (verdict && from !== undefined && from !== agentId) return fail("identity_mismatch", `Offer ${id} came from agent ${from}, not ${agentId}.`, "party.agentId");
  if (!bound) return fail("identity_mismatch", `${address} is neither the owner nor the agent wallet of agent ${agentId}.`, "party.address");

  const accepted = { ...offer, state: "accepted", acceptedAddress: address, acceptedAgentId: agentId };
  const next = offerNext(accepted, now);
  const actions = present(actionFor({ kind: "create_job", next, offer: accepted, config }), actionFor({ kind: "gas_grant", next, offer: accepted, config }));
  if (actions.length && createJobsToday >= config.caps.maxCreateJobPerDay)
    return fail("capacity_exceeded", `The daily limit of ${config.caps.maxCreateJobPerDay} new jobs is reached. Retry later.`, undefined, true);
  return status({ offer: accepted, next, actions, ops: [{ op: "accept", offerId: id, address, agentId }] });
}

export function handleDecline({ msg, offer, now, verdict = false }) {
  const id = msg.offerId;
  if (!offer || offer.direction !== (verdict ? "in" : "out")) return fail("unknown_offer", `Unknown offer ${id}.`, "offerId");
  if (offer.state === "accepted") return fail("state_mismatch", `Offer ${id} was already accepted and cannot be declined.`, "offerId");
  if (offer.state === "expired") return fail("offer_expired", `Offer ${id} expired at ${offer.expiresAt}.`, "offerId");
  if (offer.state === "declined") return status({ offer, next: offerNext(offer, now) });
  const declined = { ...offer, state: "declined" };
  return status({ offer: declined, next: offerNext(declined, now), ops: [{ op: "setOfferState", offerId: id, state: "declined" }] });
}

// One handler for the seven transition notices and query: the reply follows the chain, not the notice.
export function handleJobMessage({ name, msg, offer, job, now, config, pendingClaim = false, deliverable = null }) {
  if (msg.jobId === undefined) {
    if (!offer) return fail("unknown_offer", `Unknown offer ${msg.offerId}.`, "offerId");
    if (!job && offer.jobId == null) return status({ offer, next: offerNext(offer, now) });
  }
  if (!job) {
    const jobId = msg.jobId ?? offer.jobId;
    return fail("job_not_found", `No job ${jobId} on the escrow.`, "jobId");
  }

  const ops = [];
  if (offer && offer.chainStatus !== job.status) ops.push({ op: "setChainStatus", offerId: offer.offerId, status: job.status });
  let stored = offer?.deliverable ?? null;
  // A submitted notice is kept as an unverified reference, unless the chain already shows a different hash.
  if (name === "submitted" && offer && (!deliverable || same(deliverable, msg.deliverable.hash))) {
    stored = msg.deliverable;
    ops.push({ op: "setDeliverable", offerId: offer.offerId, deliverable: msg.deliverable });
  }

  const next = nextStep({ job, offer, now, config, pendingClaim });
  const withStored = offer ? { ...offer, deliverable: stored } : null;
  const action = next.action ? actionFor({ kind: next.action, next, job, offer: withStored, deliverable, config }) : null;
  return status({ offer, job, next, deliverable: deliverableRef(deliverable, stored), actions: present(action), ops });
}
