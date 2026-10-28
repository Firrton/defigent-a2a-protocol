// Job 22: approve + fund → espera submit del provider → complete (paga + attestation hook)
import { encodeFunctionData, parseAbi, keccak256, toHex, createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const rpc = (lines.find((l) => l.startsWith("RPC_URL=")) || lines.find((l) => l.startsWith("QUICKNODE_URL="))).split("=").slice(1).join("=").trim();

const ESCROW = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const AMT = 100000n; // 0.10 USDC
const CLAIMED = "0x561a8a343b30672a7c0a545645c63365b95c8fa8e5b512e4b23aaab9fbcd6547";

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
const pc = createPublicClient({ transport: http(rpc) });
const wc = createWalletClient({ account, transport: http(rpc) });

// 0) verificar el digest reclamado
const mine = keccak256(toHex("defigent-pilot-1138606"));
console.log("digest calculado:", mine, "| coincide:", mine.toLowerCase() === CLAIMED.toLowerCase());
if (mine.toLowerCase() !== CLAIMED.toLowerCase()) { console.log("MISMATCH — abortar"); process.exit(1); }

const gp = await pc.getGasPrice();
const gasPrice = gp * 3n > 300_000_000_000n ? gp * 3n : 300_000_000_000n;
async function sendTx(params) {
  const hash = await wc.sendTransaction({ ...params, gasPrice });
  return await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

// 1) approve + fund (solo si aún no fondeado)
const selGet = "0x" + (await import("viem")).toFunctionSelector("getJob(uint256)").slice(2);
async function readRaw() {
  const { data } = await pc.call({ to: ESCROW, data: selGet + BigInt(22).toString(16).padStart(64, "0") });
  const h = data.slice(2);
  return { status: Number(BigInt("0x" + h.slice(128, 192))), budget: BigInt("0x" + h.slice(448, 512)) };
}
let j = await readRaw();
console.log("estado inicial: status", j.status, "budget", j.budget.toString());
if (j.status === 0 && j.budget > 0n) {
  const a = await sendTx({ to: USDC, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [ESCROW, AMT] }) });
  console.log("approve:", a.status, a.transactionHash);
  const f = await sendTx({ to: ESCROW, data: encodeFunctionData({ abi: parseAbi(["function fund(uint256,address,uint256,bytes)"]), functionName: "fund", args: [22n, USDC, AMT, "0x"] }) });
  console.log("fund:", f.status, f.transactionHash);
} else if (j.status >= 1) {
  console.log("ya fondeado o más avanzado — no tocar");
}

// 2) esperar submit del provider (status 2) hasta ~7 min
for (let i = 0; i < 35; i++) {
  j = await readRaw();
  console.log(`poll ${i}: status=${j.status}`);
  if (j.status === 2) break;
  if (j.status >= 3) { console.log("estado inesperado >=3"); break; }
  await new Promise((r) => setTimeout(r, 12000));
}
if (j.status === 2) {
  const c = await sendTx({ to: ESCROW, data: encodeFunctionData({ abi: parseAbi(["function complete(uint256,bytes32,bytes)"]), functionName: "complete", args: [22n, CLAIMED, "0x"] }) });
  console.log("complete:", c.status, c.transactionHash);
  j = await readRaw();
  console.log("estado final:", j.status, "(3=Completed)");
}