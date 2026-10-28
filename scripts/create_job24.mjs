// Job 24 — audit $1.90 USDC para peer 10419 (Nhan Bui)
import { encodeFunctionData, parseAbi, createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const rpc = (lines.find((l) => l.startsWith("RPC_URL=")) || lines.find((l) => l.startsWith("QUICKNODE_URL="))).split("=").slice(1).join("=").trim();

const ESCROW = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const HOOK = "0x03d516e52fd64e2d19a817498f941d7dea452cd6";
const PEER = "0x50D39576c046357d5b6330a1404329C9872e9013";

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
const pc = createPublicClient({ transport: http(rpc) });
const wc = createWalletClient({ account, transport: http(rpc) });
const gp = await pc.getGasPrice();
const gasPrice = gp * 3n > 300_000_000_000n ? gp * 3n : 300_000_000_000n;
const now = () => Math.floor(Date.now() / 1000);

const desc = `AUDIT JOB 24 — security review of the Defigent ERC-8183 deployment. Budget: 1.90 USDC (1900000 units, Monad USDC 0x754704Bc059F8C67012fEd69BC8A327a5aafb603). SCOPE (pinned sources): https://defigent.app/contracts/ERC8183.sol (escrow impl 0xe28ed7523e2c8291d690ce1a70a9618d75af81d9 behind proxy 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65) and https://defigent.app/contracts/DefigentReputationHook.sol (hook 0x03d516e52fd64e2d19a817498f941d7dea452cd6, whitelisted selector CE79EB60); sha256 checksums posted in our A2A thread. DELIVERABLE: (1) text audit report — findings with severity, file:line, concrete patch — supplied as data in submit() AND pasted in the A2A thread; (2) deliverable = keccak256(UTF-8 exact report text). REQUIRED SECTIONS: a) state-machine bypasses across createJob/setBudget/fund/submit/complete/reject/claimRefund; b) hook trust assumptions — confirm the known issue (giveFeedback without try/catch bricked job 22 when providerAgentId existed only on Base) and propose the patch; c) fee/rounding math incl. milestone claims; d) reentrancy/griefing. FLOW: your setBudget(24, 0x754704Bc..., 1900000, 0x) -> we fund -> submit(24, deliverable, data) -> we verify -> complete -> second attestation on agentId 10419.`;

const hash = await wc.sendTransaction({ to: ESCROW, gasPrice, data: encodeFunctionData({
  abi: parseAbi(["function createJob(address provider,address evaluator,uint48 expiredAt,string desc,address hook,uint256 providerAgentId)"]),
  functionName: "createJob",
  args: [PEER, account.address, now() + 172800, desc, HOOK, 10419n] }) });
const r = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
console.log("createJob 24:", r.status, r.transactionHash);
console.log("jobId:", Number(BigInt(r.logs[r.logs.length - 1].topics[1])));