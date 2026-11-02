// ABIs for the ERC-8183 escrow, the ERC-8004 identity registry and ERC-20 tokens.
import { parseAbi } from "viem";

export const ESCROW_ABI = parseAbi([
  "struct Job { address client; uint8 status; address provider; uint48 expiredAt; address evaluator; uint48 submittedAt; uint256 budget; address hook; address paymentToken; uint256 providerAgentId; string description; uint256 settledAmount; address payoutReceiver; }",
  "function createJob(address provider, address evaluator, uint48 expiredAt, string description, address hook, uint256 providerAgentId) returns (uint256)",
  "function setBudget(uint256 jobId, address token, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function getJob(uint256 jobId) view returns (Job)",
  "function jobCounter() view returns (uint256)",
  "function allowedPaymentTokens(address token) view returns (bool)",
  "function pendingClaimHash(uint256 jobId) view returns (bytes32)",
  "function whitelistedHooks(address hook) view returns (bool)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint48 expiredAt, address hook)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
]);

export const IDENTITY_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

// Index = on-chain JobStatus enum value (ERC8183.sol).
export const JOB_STATUS = Object.freeze(["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"]);

// ERC8183.EVALUATION_GRACE_PERIOD.
export const EVALUATION_GRACE_SECONDS = 3600;
