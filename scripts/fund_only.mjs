// Fondeo sin complete: espera setBudget(jobId) → approve+fund → notifica (la evaluación es del operador)
import { encodeFunctionData, parseAbi, createPublicClient, http, createWalletClient, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const rpc = (lines.find((l) => l.startsWith("RPC_URL=")) || lines.find((l) => l.startsWith("QUICKNODE_URL="))).split("=").slice(1).join("=").trim();
const ESCROW = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const JOB = BigInt(process.argv[2] || 24);
const AMT = BigInt(process.argv[3] || 1900000);

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
const pc = createPublicClient({ transport: http(rpc) });
const wc = createWalletClient({ account, transport: http(rpc) });
const gp = await pc.getGasPrice();
const gasPrice = gp * 3n > 300_000_000_000n ? gp * 3n : 300_000_000_000n;
const SEL = toFunctionSelector("getJob(uint256)");
const st = ["Open","Funded","Submitted","Completed","Rejected","Expired"];

async function readState() {
  const { data } = await pc.call({ to: ESCROW, data: "0x" + SEL.slice(2) + JOB.toString(16).padStart(64, "0") });
  const h = data.slice(2);
  return { status: Number(BigInt("0x" + h.slice(128, 192))), budget: BigInt("0x" + h.slice(448, 512)) };
}
async function sendTx(p) {
  const hash = await wc.sendTransaction({ ...p, gasPrice });
  return await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

for (let i = 0; i < 200; i++) { // ~40 min
  let s; try { s = await readState(); } catch { await new Promise(r => setTimeout(r, 15000)); continue; }
  console.log(`[${new Date().toISOString().slice(11,19)}] ${st[s.status]} budget=${s.budget}`);
  if (s.status === 0 && s.budget > 0n) {
    if (s.budget !== AMT) { console.log("budget distinto al esperado — no fondear, revisar"); break; }
    const a = await sendTx({ to: USDC, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [ESCROW, AMT] }) });
    console.log("approve:", a.status, a.transactionHash);
    const f = await sendTx({ to: ESCROW, data: encodeFunctionData({ abi: parseAbi(["function fund(uint256,address,uint256,bytes)"]), functionName: "fund", args: [JOB, USDC, AMT, "0x"] }) });
    console.log("fund:", f.status, f.transactionHash);
    console.log("FUNDED — esperando submit del provider; evaluación del reporte en manos del operador");
    break;
  }
  if (s.status >= 1) { console.log("ya fondeado/avanzado"); break; }
  await new Promise(r => setTimeout(r, 12000));
}
console.log("watcher terminado");