// Typed jobs protocol v1: what an operator action sends on chain and the outbox line that reports it. Pure: no keys, no RPC.
// scripts/jobs_actions.mjs signs and sends the transactions; the inbox verifies the outbox line on chain before it touches the ledger.
import { encodeEventTopics, encodeFunctionData, keccak256, toBytes } from "viem";
import { ERC20_ABI, ESCROW_ABI } from "./abi.mjs";
import { fullKey } from "./protocol.mjs";

// complete() reverts with InsufficientGas when the hook's attestation could fail silently; it needs ~610k gas on cold state.
const COMPLETE_GAS_FLOOR = 700000n;
const JOB_CREATED_TOPIC = encodeEventTopics({ abi: ESCROW_ABI, eventName: "JobCreated" })[0];

const escrowTx = (label, config, functionName, args, extra = {}) => ({
  label, to: config.escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName, args }), ...extra,
});

function evaluateVerdict(verdict) {
  if (verdict === undefined) throw new Error("evaluate: verdict required (complete or reject)");
  if (verdict !== "complete" && verdict !== "reject") throw new Error(`evaluate: verdict must be complete or reject, not ${JSON.stringify(verdict)}`);
  return verdict;
}

function reviewVerdict(verdict) {
  if (verdict === undefined) throw new Error("review_offer: verdict required (accept or decline)");
  if (verdict !== "accept" && verdict !== "decline") throw new Error(`review_offer: verdict must be accept or decline, not ${JSON.stringify(verdict)}`);
  return verdict;
}

// The transactions of `action` (an ActionRow), in the order they must be mined. The payload is the exact operation the
// inbox queued (R8); review_offer and review_claim send nothing and only answer through the outbox.
export function buildActionTxs(action, config, { verdict, reason } = {}) {
  const p = action.payload;
  switch (action.action) {
    case "create_job":
      return [escrowTx("createJob", config, "createJob", [p.provider, p.evaluator, p.expiredAt, p.description, p.hook, BigInt(p.agentId)])];
    case "fund":
      return [
        { label: "approve", to: p.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [config.escrow, BigInt(p.amount)] }) },
        escrowTx("fund", config, "fund", [BigInt(p.jobId), p.token, BigInt(p.amount), "0x"]),
      ];
    case "evaluate":
      if (evaluateVerdict(verdict) === "complete")
        return [escrowTx("complete", config, "complete", [BigInt(p.jobId), keccak256(toBytes(reason ?? "accepted")), "0x"], { gasFloor: COMPLETE_GAS_FLOOR })];
      return [escrowTx("reject", config, "reject", [BigInt(p.jobId), keccak256(toBytes(reason ?? "rejected")), "0x"])];
    case "refund":
      return [escrowTx("claimRefund", config, "claimRefund", [BigInt(p.jobId)])];
    case "gas_grant":
      return [{ label: "transfer", to: p.to, value: BigInt(p.amountWei), data: "0x" }];
    case "review_offer":
    case "review_claim":
      return [];
    default:
      throw new Error(`unknown action ${action.action}`);
  }
}

// The jobId of the JobCreated event the escrow emitted in a createJob receipt (topics[1]), or null when there is none.
export function createdJobId(logs, escrow) {
  const log = logs.find((l) => l.address?.toLowerCase() === escrow.toLowerCase() && l.topics?.[0] === JOB_CREATED_TOPIC);
  return log ? BigInt(log.topics[1]).toString() : null;
}

const viaTx = (txHash) => (txHash ? ` (tx ${txHash})` : "");
const notice = (jobId, txHash) => ({ jobId: String(jobId), ...(txHash ? { txHash } : {}) });

// The outbox line that reports a finished action: the text the peer reads, the task state and the typed claim the inbox
// verifies on chain. replyId is the action key, so the line applies once. review_claim has no line (R14): the operator
// settles it by hand. gas_grant carries no data, since the outbox rejects data: null.
export function outboxLineFor(action, { txHash, jobId, verdict, party } = {}) {
  const p = action.payload;
  const line = (state, text, name, body) => ({
    contextId: action.contextId, text, state, ...(name ? { data: { [fullKey(name)]: body } } : {}), replyId: action.key,
  });
  switch (action.action) {
    case "create_job": {
      if (jobId === undefined || jobId === null) throw new Error("create_job: jobId required");
      return line("input-required",
        `Job ${jobId} is created on the ERC-8183 escrow for offer ${p.offerId}${viaTx(txHash)}. Next: the provider calls setBudget(${jobId}, ${p.token}, ${p.amount}, 0x) with the agreed amount.`,
        "created", { offerId: p.offerId, ...notice(jobId, txHash) });
    }
    case "fund":
      return line("input-required",
        `Job ${p.jobId} is funded with ${p.amount} base units of ${p.token}${viaTx(txHash)}. Next: the provider delivers and calls submit(${p.jobId}, <deliverable hash>, 0x).`,
        "funded", notice(p.jobId, txHash));
    case "evaluate":
      if (evaluateVerdict(verdict) === "complete")
        return line("completed", `Job ${p.jobId} is completed: the deliverable was accepted and the escrow released the payment${viaTx(txHash)}.`, "completed", notice(p.jobId, txHash));
      return line("failed", `Job ${p.jobId} was rejected: the deliverable was not accepted and the escrow refunded the client${viaTx(txHash)}.`, "rejected", notice(p.jobId, txHash));
    case "refund":
      return line("failed", `Job ${p.jobId} expired without a settled deliverable and the escrow refunded the client${viaTx(txHash)}.`, "expired", notice(p.jobId, txHash));
    case "gas_grant":
      return line("input-required", `Defigent sent ${p.amountWei} wei to ${p.to} to pay the gas of the provider transactions${viaTx(txHash)}.`);
    case "review_offer":
      if (reviewVerdict(verdict) === "accept") {
        if (!party) throw new Error("review_offer: party required to accept (address and agentId)");
        return line("working",
          `Defigent accepts offer ${p.offerId}. Next: Defigent creates the ERC-8183 job with ${party.address} (agent ${party.agentId}) as the provider.`,
          "accept", { offerId: p.offerId, party: { address: party.address, agentId: party.agentId } });
      }
      // R15: our decline of an inbound offer leaves the task rejected.
      return line("rejected", `Defigent declines offer ${p.offerId}.`, "decline", { offerId: p.offerId, reason: "other" });
    case "review_claim":
      return null;
    default:
      throw new Error(`unknown action ${action.action}`);
  }
}
