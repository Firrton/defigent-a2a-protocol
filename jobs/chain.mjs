// Read-only access to the ERC-8183 escrow and the ERC-8004 identity registry. Every call has its own timeout and
// turns any RPC failure into ChainUnavailable; contract reverts are answers, not failures.
import {
  ContractFunctionRevertedError, ExecutionRevertedError, createPublicClient, decodeErrorResult, defineChain, http, parseAbi, zeroAddress, zeroHash,
} from "viem";
import { ESCROW_ABI, IDENTITY_ABI, JOB_STATUS } from "./abi.mjs";

export class ChainUnavailable extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ChainUnavailable";
  }
}

// JobSubmitted is looked up over this many recent blocks, in a single eth_getLogs.
const LOG_WINDOW_BLOCKS = 50000n;

// ERC8183.sol custom errors, so a simulation reports "WrongStatus" instead of a selector.
const ESCROW_ERRORS = parseAbi([
  "error InvalidJob()", "error InvalidHook()", "error InvalidReceiver()", "error WrongStatus()", "error Unauthorized()", "error ZeroAddress()",
  "error ExpiryTooShort()", "error ProviderNotSet()", "error FeesTooHigh()", "error HookNotWhitelisted()", "error BudgetMismatch()",
  "error PaymentTokenMismatch()", "error ProviderCannotBeEvaluator()", "error ClientCannotBeProvider()", "error GracePeriodActive()",
  "error PaymentTokenNotAllowed()", "error UnexpectedFundedAmount()", "error NoNewSettlement()", "error ExceedsBudget()",
  "error ClaimAlreadySubmitted()", "error EmptyDeliverable()", "error PendingClaimExists()", "error NoPendingClaim()",
]);

const monad = (rpcUrl) => defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const isBaseError = (e) => typeof e?.walk === "function";

// The innermost error that says the EVM reverted, or null for a node, network or timeout failure.
function revertOf(err) {
  if (!isBaseError(err)) return null;
  return err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError || e?.code === ExecutionRevertedError.code
    || /execution reverted/i.test(e?.details ?? "")) ?? null;
}

function revertData(err) {
  const withData = err.walk((e) => typeof e?.data === "string" || typeof e?.data?.data === "string" || typeof e?.raw === "string");
  const data = withData?.raw ?? withData?.data?.data ?? withData?.data;
  return typeof data === "string" && data.startsWith("0x") && data.length >= 10 ? data : null;
}

function revertReason(err) {
  const data = revertData(err);
  if (data) {
    try {
      const { errorName, args = [] } = decodeErrorResult({ abi: ESCROW_ERRORS, data });
      if (errorName === "Error") return String(args[0]);
      return args.length ? `${errorName}(${args.map(String).join(",")})` : errorName;
    } catch {
      return `execution reverted with ${data.slice(0, 10)}`;
    }
  }
  const reverted = revertOf(err);
  return reverted?.reason ?? reverted?.details ?? "execution reverted";
}

// A node refusing an eth_getLogs over too wide a range or with too many results. Only the node's own text is
// matched (details, or the innermost message), never viem's wrapper messages.
const LOG_LIMIT = /range|limit|too many|too large|exceed/i;
function isLogLimit(err) {
  if (!isBaseError(err)) return false;
  return !!err.walk((e) => e?.code === -32005 || LOG_LIMIT.test(e?.details ?? "")) || LOG_LIMIT.test(err.walk()?.message ?? "");
}

function toJob(jobId, s) {
  if (s.client === zeroAddress) return null;
  return {
    jobId, client: s.client, status: JOB_STATUS[s.status] ?? `Unknown(${s.status})`, provider: s.provider, expiredAt: Number(s.expiredAt),
    evaluator: s.evaluator, submittedAt: Number(s.submittedAt), budget: s.budget, hook: s.hook, paymentToken: s.paymentToken,
    providerAgentId: s.providerAgentId, description: s.description, settledAmount: s.settledAmount, payoutReceiver: s.payoutReceiver,
  };
}

export function createChainReader({ config, rpcUrl, timeoutMs = config.rpcTimeoutMs, transport }) {
  const client = createPublicClient({ chain: monad(rpcUrl), transport: transport ?? http(rpcUrl, { retryCount: 0 }) });

  async function guard(label, fn) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ChainUnavailable(`${label}: no answer from the chain within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([fn(), timeout]);
    } catch (e) {
      if (e instanceof ChainUnavailable) throw e;
      throw new ChainUnavailable(`${label}: ${e?.shortMessage ?? e?.message ?? String(e)}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  const escrow = (functionName, args) => client.readContract({ address: config.escrow, abi: ESCROW_ABI, functionName, args });
  // An identity read that reverts (agentId not minted, no wallet) answers null.
  const identity = (functionName, agentId) =>
    guard(functionName, () => client.readContract({ address: config.identityRegistry, abi: IDENTITY_ABI, functionName, args: [agentId] })
      .catch((e) => { if (revertOf(e)) return null; throw e; }));

  return {
    async getJob(jobId) {
      return toJob(jobId, await guard("getJob", () => escrow("getJob", [jobId])));
    },
    async isAllowedToken(addr) {
      return guard("allowedPaymentTokens", () => escrow("allowedPaymentTokens", [addr]));
    },
    async isBoundToAgent(addr, agentId) {
      const matches = (a) => typeof a === "string" && a !== zeroAddress && a.toLowerCase() === addr.toLowerCase();
      const owner = await identity("ownerOf", agentId);
      if (owner === null) return false;
      if (matches(owner)) return true;
      return matches(await identity("getAgentWallet", agentId));
    },
    async hasPendingClaim(jobId) {
      return (await guard("pendingClaimHash", () => escrow("pendingClaimHash", [jobId]))) !== zeroHash;
    },
    async submittedDeliverable(jobId) {
      const latest = await guard("blockNumber", () => client.getBlockNumber({ cacheTime: 0 }));
      const fromBlock = latest > LOG_WINDOW_BLOCKS ? latest - LOG_WINDOW_BLOCKS : 0n;
      const event = ESCROW_ABI.find((x) => x.type === "event" && x.name === "JobSubmitted");
      const logs = await guard("JobSubmitted logs", () => client.getLogs({ address: config.escrow, event, args: { jobId }, fromBlock, toBlock: latest })
        .catch((e) => { if (isLogLimit(e)) return null; throw e; }));
      const last = logs?.at(-1);
      return last ? last.args.deliverable.toLowerCase() : null;
    },
    async blockTime() {
      return Number((await guard("getBlock", () => client.getBlock())).timestamp);
    },
    async simulate({ account, to, data, value }) {
      return guard("simulate", () => client.call({ account, to, data, value }).then(() => ({ ok: true }), (e) => {
        if (revertOf(e)) return { ok: false, reason: revertReason(e) };
        throw e;
      }));
    },
  };
}
