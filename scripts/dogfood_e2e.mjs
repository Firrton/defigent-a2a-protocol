// Defigent — dogfood E2E: el job 6 del escrow (keccak256 de un texto) ejecutado
// por una wallet efímera "independiente" (el patrón del selftest 10407).
// Genera wallet nueva, recibe gas+job, submita el hash, evalúa, completa, cobra.
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, createPublicClient, http, formatEther } from "viem";
import { defineChain } from "viem";
import fs from "fs";

const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
});

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find(l => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const clientWallet = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : ("0x" + rawKey));
const RPC = process.env.QUICKNODE_URL || "https://rpc.monad.xyz";
const pc = createPublicClient({ chain: monad, transport: http(RPC) });

const PROXY = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"; // USDC nativo Monad (allowlisted en el escrow)

// read env USDC
const usdcAddr = (lines.find(l => l.startsWith("MONAD_USDC="))?.split("=")[1] || "").trim() || USDC;

// 1. wallet efímera nueva
const worker = privateKeyToAccount(keccak256(toHex("defigent-dogfood-" + Date.now())).slice(0, 2) === "0x" ? keccak256(toHex("defigent-dogfood-" + Date.now())) : "0x0");
console.log("worker wallet:", worker.address);

// helpers
const sendTx = async (wallet, tx) => {
  const nonce = await pc.getTransactionCount({ address: wallet.address });
  const gp = (await pc.getGasPrice()) * 11n / 10n;
  const stx = { nonce, gasPrice: gp, chainId: 143, ...tx };
  try {
    const gas = await pc.estimateGas({ ...stx, account: wallet });
    stx.gas = (gas * 130n) / 100n;
  } catch (e) {
    // estimate falló (p.ej. hook revert en simulación) → gas fijo conservador
    stx.gas = tx.gas || 2_500_000n;
  }
  const signed = await wallet.signTransaction(stx);
  return pc.sendRawTransaction({ serializedTransaction: signed });
};
const wait = async (h) => { const r = await pc.waitForTransactionReceipt({ hash: h, timeout: 30_000 }); if (r.status !== "success") throw new Error("tx reverted: " + h); return r; };
const sel = (name) => keccak256(toHex(name)).slice(0, 10);

// ABI-encode helpers (viem)
import { encodeFunctionData, parseAbi } from "viem";
const ABI = parseAbi([
  "function createJob(address provider,address evaluator,uint48 expiredAt,string desc,address hook,uint256 providerAgentId)",
  "function setProvider(uint256 jobId,address provider,uint256 agentId)",
  "function setBudget(uint256 jobId,address token,uint256 amount,bytes optParams)",
  "function fund(uint256 jobId,address token,uint256 amount,bytes data)",
  "function submit(uint256 jobId,bytes32 deliverable,bytes data)",
  "function complete(uint256 jobId,bytes32 deliverable,bytes data)",
  "function getJob(uint256) view returns (address provider,address client,uint48 expiredAt,string desc,address hook,address token,uint256 budget,uint8 state,bool refunded)",
]);
const enc = (name, args) => encodeFunctionData({ abi: ABI, functionName: name, args });

const now = () => Math.floor(Date.now() / 1000);

// 2. client (nuestra wallet) crea job 9 con worker como provider
const desc = `DOGFOOD JOB A: return the keccak256 hex digest of the exact UTF-8 text "defigent-dogfood-${now()}". Budget: 0.05 USDC. Executed by an independent agent wallet (dogfood pattern).`;
const h1 = await sendTx(clientWallet, { to: PROXY, data: enc("createJob", ["0x0000000000000000000000000000000000000000", clientWallet.address, now() + 3600, desc, "0x0000000000000000000000000000000000000000", 0]) });
const r1 = await wait(h1);
console.log("createJob:", r1.status, r1.logs.length ? "ok" : "no logs");
// jobId = counter anterior +1 → leer counter
const cnt = await pc.readContract({ address: PROXY, abi: ABI, functionName: "getJob", args: [] }).catch(() => null);
// mejor: obtener jobId de los logs Created
const createdLog = r1.logs[r1.logs.length - 1];
const jobId = Number(BigInt(createdLog.topics[1]));
console.log("jobId:", jobId);

// 3. setProvider(worker)
const h2 = await sendTx(clientWallet, { to: PROXY, data: enc("setProvider", [jobId, worker.address, 0]) });
console.log("setProvider:", (await wait(h2)).status);

// 4. GAS AL WORKER primero (el setBudget es del PROVIDER)
const amt = 50000n; // 0.05 USDC (6 dec)
const h6 = await sendTx(clientWallet, { to: worker.address, value: 500000000000000000n, data: "0x" });
console.log("gas al worker (0.5 MON):", (await wait(h6)).status);

// 5. WORKER setea su presupuesto (0.05 USDC en USDC nativo)
console.log("worker balance antes de setBudget:", formatEther(await pc.getBalance({ address: worker.address })), "MON");
const h3 = await sendTx(worker, { to: PROXY, data: enc("setBudget", [jobId, usdcAddr, amt, "0x"]) });
console.log("worker setBudget:", (await wait(h3)).status);

// 6. client fonda el escrow
const approveData = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [PROXY, amt] });
const h4 = await sendTx(clientWallet, { to: usdcAddr, data: approveData });
console.log("approve:", (await wait(h4)).status);
const h5 = await sendTx(clientWallet, { to: PROXY, data: enc("fund", [jobId, usdcAddr, amt, "0x"]) });
console.log("fund:", (await wait(h5)).status);

// 6. WORKER submita el deliverable
const text = desc.match(/UTF-8 text "([^"]+)"/)[1];
const digest = keccak256(toHex(text));
console.log("worker computa:", text, "→", digest);
const h7 = await sendTx(worker, { to: PROXY, data: enc("submit", [jobId, digest, "0x"]) });
console.log("worker submit:", (await wait(h7)).status);

// 7. client completa → escrow paga al worker
const h8 = await sendTx(clientWallet, { to: PROXY, data: enc("complete", [jobId, digest, "0x"]) });
const r8 = await wait(h8);
console.log("complete:", r8.status);
const bal = await pc.getBalance({ address: worker.address });
console.log("worker balance tras el ciclo:", formatEther(bal - 50000000000000000n), "MON ganados en gas sobrante");
console.log("✅ DOGFOOD COMPLETO — ciclo agente→agente E2E en el escrow de Monad");
