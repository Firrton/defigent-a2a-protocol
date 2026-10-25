// The next step of an offer or an ERC-8183 job, and the A2A task state it implies. Pure functions, no I/O.
import { encodeFunctionData, getAbiItem, toFunctionSignature } from "viem";
import { ESCROW_ABI, EVALUATION_GRACE_SECONDS } from "./abi.mjs";

// evaluate turns urgent this long before the end of the evaluation window.
const URGENT_SECONDS = 6 * 3600;

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const signature = (name) => toFunctionSignature(getAbiItem({ abi: ESCROW_ABI, name }));
const other = (side) => (side === "client" ? "provider" : "client");

function none(note) {
  return { actor: null, ours: false, note };
}

function setBudget(jobId, price, config) {
  const step = { actor: "provider", ours: false, to: config.escrow, function: signature("setBudget") };
  if (!price) return { ...step, args: [jobId.toString(), null, null, "0x"], note: "Set the budget the parties agreed on." };
  return {
    ...step,
    args: [jobId.toString(), price.token, price.amount, "0x"],
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "setBudget", args: [jobId, price.token, BigInt(price.amount), "0x"] }),
    note: "Set the agreed budget. Defigent funds the escrow right after.",
  };
}

export function nextStep({ job, offer, now, config, pendingClaim = false }) {
  const isClient = same(job.client, config.client);
  const price = offer?.terms?.price ?? null;
  const jobId = job.jobId.toString();

  if ((job.status === "Open" || job.status === "Funded") && now >= job.expiredAt) {
    // claimRefund reverts with PendingClaimExists on Open and Funded jobs while a claim is pending.
    if (pendingClaim) return none("The job expired, but a pending claim blocks the refund until it is resolved.");
    return { actor: "anyone", ours: isClient, action: "refund", note: "The job expired. Anyone can call claimRefund to return the budget to the client." };
  }

  switch (job.status) {
    case "Open": {
      if (job.budget === 0n) return setBudget(job.jobId, price, config);
      if (!price) return { actor: "client", ours: isClient, note: "The budget is set. The client decides whether to fund it; no agreed terms are on record." };
      if (job.budget !== BigInt(price.amount) || !same(job.paymentToken, price.token))
        return { ...setBudget(job.jobId, price, config), mismatch: true, note: "The budget on chain differs from the agreed terms. Set the agreed budget again." };
      return { actor: "client", ours: isClient, action: "fund", note: "The agreed budget is set. The client approves the token and funds the escrow." };
    }
    case "Funded":
      return {
        actor: "provider", ours: false, to: config.escrow, function: signature("submit"), args: [jobId, "keccak256(deliverable)", "0x"],
        note: "The escrow is funded. Do the work and submit the keccak256 hash of the deliverable.",
      };
    case "Submitted": {
      const deadline = job.expiredAt + EVALUATION_GRACE_SECONDS;
      return {
        actor: "evaluator", ours: same(job.evaluator, config.evaluator), action: "evaluate", deadline, urgent: now >= deadline - URGENT_SECONDS,
        note: "The deliverable was submitted. The evaluator completes or rejects the job before the deadline.",
      };
    }
    case "Completed":
      return none("The job is completed and the provider was paid.");
    case "Rejected":
      return none("The evaluator rejected the deliverable.");
    case "Expired":
      return none("The job expired.");
    default:
      return none(`Unknown job status ${JSON.stringify(job.status)}.`);
  }
}

// The side we play in an offer: ours when we sent it, the opposite one when we received it.
const ourSide = (offer) => (offer.direction === "out" ? offer.terms.side : other(offer.terms.side));

export function offerNext(offer, now) {
  const pending = offer.state === "open" || offer.state === "under_review";
  if (pending && now >= offer.expiresAt) return none("The offer expired.");
  if (pending && offer.direction === "out")
    return { actor: other(ourSide(offer)), ours: false, note: "Waiting for the counterparty to accept or decline the offer." };
  if (pending) return { actor: ourSide(offer), ours: true, note: "Defigent is reviewing the offer." };
  switch (offer.state) {
    case "accepted":
      if (offer.jobId != null) return none(`Job ${offer.jobId} exists; its on-chain state decides the next step.`);
      return { actor: "client", ours: ourSide(offer) === "client", action: "create_job", note: "The offer was accepted. The client creates the job on the escrow." };
    case "declined":
      return none("The offer was declined.");
    case "expired":
      return none("The offer expired.");
    default:
      return none(`Unknown offer state ${JSON.stringify(offer.state)}.`);
  }
}

export function taskStateFor({ next, job, offer }) {
  if (job?.status === "Completed") return "completed";
  if (job?.status === "Rejected" || job?.status === "Expired") return "failed";
  if (!job && offer) {
    if (offer.state === "declined") return offer.direction === "out" ? "completed" : "rejected";
    // An open offer only loses its actor by passing expiresAt before the ledger marks it expired.
    if (offer.state === "expired" || ((offer.state === "open" || offer.state === "under_review") && next?.actor === null)) return "failed";
  }
  return next?.ours ? "working" : "input-required";
}
