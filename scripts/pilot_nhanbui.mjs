// Pilot con peer #1 (Nhan Bui, agentId 1138606): seed de gas + createJob en el escrow ERC-8183
import { encodeFunctionData, parseAbi, keccak256, toHex, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { createWalletClient, http as httpT } from "viem";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const rpc = lines.find((l) => l.startsWith("RPC_URL="))?.slice("RPC_URL=".length).trim()
  || lines.find((l) => l.startsWith("QUICKNODE_URL="))?.slice("QUICKNODE_URL=".length).trim();

const PROXY = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const HOOK  = "0x03d516e52fd64e2d19a817498f941d7dea452cd6";
const USDC  = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const PEER  = "0x50D39576c046357d5b6330a1404329C9872e9013";
const PEER_AGENT_ID = 1138606n;

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
const pc = createPublicClient({ transport: http(rpc) });
const wc = createWalletClient({ account, transport: httpT(rpc) });

const ABI = parseAbi([
  "function createJob(address provider,address evaluator,uint48 expiredAt,string desc,address hook,uint256 providerAgentId)",
  "function getJob(uint256) view returns (address provider,address client,uint48 expiredAt,string desc,address hook,address token,uint256 budget,uint8 state,bool refunded)",
]);

const now = () => Math.floor(Date.now() / 1000);
const gp = await pc.getGasPrice();
const gasPrice = gp * 3n > 300_000_000_000n ? gp * 2n : 300_000_000_000n; // floor 300 gwei

async function sendTx(params) {
  const hash = await wc.sendTransaction({ ...params, gasPrice });
  return await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

// 1) seed de gas al provider (setBudget + submit son SUYOS — pidió ~0.02, damos margen)
const seed = await sendTx({ to: PEER, value: 50_000_000_000_000_000n }); // 0.05 MON
console.log("seed gas 0.05 MON →", seed.status, seed.transactionHash);

// 2) createJob con provider + agentId + hook (attestation automática al complete)
const TEXT = "defigent-pilot-1138606";
const desc = `PILOT JOB — peer #1 (Nhan Bui node, ERC-8004 agentId 1138606). Return the keccak256 hex digest of the exact UTF-8 text "${TEXT}". Budget: 0.10 USDC (Monad USDC native). Flow: provider setBudget(jobId, USDC, 0.100000) -> client funds -> provider submit(jobId, keccak256("${TEXT}"), 0x) -> client complete -> reputation hook attests agentId 1138606 automatically. Poll this job via getJob(jobId) on 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65.`;
const r1 = await sendTx({ to: PROXY, data: encodeFunctionData({
  abi: ABI, functionName: "createJob",
  args: [PEER, account.address, now() + 172800, desc, HOOK, PEER_AGENT_ID] }) });
console.log("createJob →", r1.status, r1.transactionHash);
const createdLog = r1.logs[r1.logs.length - 1];
const jobId = Number(BigInt(createdLog.topics[1]));
console.log("jobId:", jobId);
const job = await pc.readContract({ address: PROXY, abi: ABI, functionName: "getJob", args: [BigInt(jobId)] });
console.log("getJob:", JSON.stringify(job, (k,v)=>typeof v==="bigint"?v.toString():v));
console.log("deliverable esperado:", keccak256(toHex(TEXT)));