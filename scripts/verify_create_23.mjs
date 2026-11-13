// Verifica ownerOf(10419) en el registro Monad y crea job 23 con providerAgentId=10419
import { encodeFunctionData, parseAbi, keccak256, toHex, createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const rpc = (lines.find((l) => l.startsWith("RPC_URL=")) || lines.find((l) => l.startsWith("QUICKNODE_URL="))).split("=").slice(1).join("=").trim();

const ESCROW = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const HOOK = "0x03d516e52fd64e2d19a817498f941d7dea452cd6";
const PEER = "0x50D39576c046357d5b6330a1404329C9872e9013";
const NEW_ID = 10419n;

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
const pc = createPublicClient({ transport: http(rpc) });

// 1) VERIFICAR el claim: ownerOf(10419) == su wallet
const owner = await pc.readContract({ address: IDENTITY, abi: parseAbi(["function ownerOf(uint256) view returns (address)"]), functionName: "ownerOf", args: [NEW_ID] });
console.log("ownerOf(10419):", owner);
if (owner.toLowerCase() !== PEER.toLowerCase()) { console.log("MISMATCH — no crear job"); process.exit(1); }
console.log("claim verificado ✓");

// 2) createJob 23
const wc = createWalletClient({ account, transport: http(rpc) });
const gp = await pc.getGasPrice();
const gasPrice = gp * 3n > 300_000_000_000n ? gp * 3n : 300_000_000_000n;
const now = () => Math.floor(Date.now() / 1000);
const desc = 'PILOT JOB 23 — peer #1 (Nhan Bui node, MONAD ERC-8004 agentId 10419, owner verified). Return the keccak256 hex digest of the exact UTF-8 text "defigent-pilot-1138606" (same deliverable as before — your digest 0x561a8a343b30672a7c0a545645c63365b95c8fa8e5b512e4b23aaab9fbcd6547 applies). Budget: 0.10 USDC. Flow: provider setBudget(23, 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, 100000, 0x) -> client funds -> provider submit(23, digest, 0x) -> client complete -> reputation hook attests agentId 10419.';
const hash = await wc.sendTransaction({ to: ESCROW, gasPrice, data: encodeFunctionData({
  abi: parseAbi(["function createJob(address provider,address evaluator,uint48 expiredAt,string desc,address hook,uint256 providerAgentId)"]),
  functionName: "createJob",
  args: [PEER, account.address, now() + 172800, desc, HOOK, NEW_ID] }) });
const r = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
console.log("createJob 23:", r.status, r.transactionHash);
const jobId = Number(BigInt(r.logs[r.logs.length - 1].topics[1]));
console.log("jobId:", jobId);