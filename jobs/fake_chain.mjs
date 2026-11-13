// In-memory ChainReader for tests: fixed fixtures, a call counter, and switchable failure (immediate) or hang (rejects after timeoutMs).
import { ChainUnavailable } from "./chain.mjs";

const key = (id) => String(id);
const lower = (a) => String(a).toLowerCase();

export function createFakeChain({
  jobs = {}, bindings = [], allowedTokens = [], now = 1792000000, pendingClaims = [], deliverables = {}, simulate = () => ({ ok: true }),
  fail = false, hang = false, timeoutMs = 50,
} = {}) {
  let calls = 0;
  const pending = new Set(pendingClaims.map(key));
  const allowed = new Set(allowedTokens.map(lower));

  function answer(label, fn) {
    calls += 1;
    if (fail) return Promise.reject(new ChainUnavailable(`${label}: fake chain is failing`));
    if (hang) return new Promise((_, reject) => setTimeout(() => reject(new ChainUnavailable(`${label}: fake chain hung for ${timeoutMs} ms`)), timeoutMs));
    return Promise.resolve().then(fn);
  }

  return {
    get calls() {
      return calls;
    },
    setFail(value) {
      fail = value;
    },
    setHang(value) {
      hang = value;
    },
    getJob: (jobId) => answer("getJob", () => (Object.hasOwn(jobs, key(jobId)) ? { jobId: BigInt(jobId), ...jobs[key(jobId)] } : null)),
    isAllowedToken: (addr) => answer("allowedPaymentTokens", () => allowed.has(lower(addr))),
    isBoundToAgent: (addr, agentId) =>
      answer("isBoundToAgent", () => bindings.some((b) => lower(b.address) === lower(addr) && BigInt(b.agentId) === BigInt(agentId))),
    hasPendingClaim: (jobId) => answer("pendingClaimHash", () => pending.has(key(jobId))),
    submittedDeliverable: (jobId) => answer("JobSubmitted logs", () => deliverables[key(jobId)] ?? null),
    blockTime: () => answer("getBlock", () => now),
    simulate: (tx) => answer("simulate", () => simulate(tx)),
  };
}
