// Job 22: reject (evaluator) → refund + seed extra para registro ERC-8004 en Monad
import { encodeFunctionData, parseAbi, keccak256, toHex, createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const rpc = (lines.find((l) => l.startsWith("RPC_URL=")) || lines.find((l) => l.startsWith("QUICKNODE_URL="))).split("=").slice(1).join("=").trim();
const ESCROW = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const PEER = "0x50D39576c046357d5b6330a1404329C9872e9013";

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
const pc = createPublicClient({ transport: http(rpc) });
const wc = createWalletClient({ account, transport: http(rpc) });
const gp = await pc.getGasPrice();
const gasPrice = gp * 3n > 300_000_000_000n ? gp * 3n : 300_000_000_000n;
async function sendTx(p) {
  const hash = await wc.sendTransaction({ ...p, gasPrice });
  return await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

// 1) reject como evaluator → Rejected + refund de 0.10 USDC al client (nosotros)
const reason = keccak256(toHex("providerAgentId is Base-only (1138606); rerun with Monad ERC-8004 id"));
const r = await sendTx({ to: ESCROW, data: encodeFunctionData({
  abi: parseAbi(["function reject(uint256,bytes32,bytes)"]),
  functionName: "reject", args: [22n, reason, "0x"] }) });
console.log("reject:", r.status, r.transactionHash);
for (const lg of r.logs) {
  console.log("  log topic0:", lg.topics[0]?.slice(0,10), "data:", (lg.data||"0x").slice(0,66));
}

// 2) semilla extra 0.30 MON para su registro ERC-8004 en Monad (register gas)
const s = await sendTx({ to: PEER, value: 300_000_000_000_000_000n });
console.log("seed +0.30 MON:", s.status, s.transactionHash);

// 3) estado final
const sel = "0x" + (await import("viem")).toFunctionSelector("getJob(uint256)").slice(2);
const { data } = await pc.call({ to: ESCROW, data: sel + BigInt(22).toString(16).padStart(64, "0") });
const st = ["Open","Funded","Submitted","Completed","Rejected","Expired"];
console.log("job 22 final:", st[Number(BigInt("0x" + data.slice(2).slice(128, 192)))]);