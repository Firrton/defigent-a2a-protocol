// Job 23: ciclo autónomo — espera setBudget → approve+fund → espera submit → complete (attests 10419)
import { encodeFunctionData, parseAbi, createPublicClient, http, createWalletClient, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const rpc = (lines.find((l) => l.startsWith("RPC_URL=")) || lines.find((l) => l.startsWith("QUICKNODE_URL="))).split("=").slice(1).join("=").trim();

const ESCROW = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const AMT = BigInt(process.argv[3] || 100000);
const DIGEST = "0x561a8a343b30672a7c0a545645c63365b95c8fa8e5b512e4b23aaab9fbcd6547";
const JOB = BigInt(process.argv[2] || 23);

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
const pc = createPublicClient({ transport: http(rpc) });
const wc = createWalletClient({ account, transport: http(rpc) });
const gp = await pc.getGasPrice();
const gasPrice = gp * 3n > 300_000_000_000n ? gp * 3n : 300_000_000_000n;

const SEL = toFunctionSelector("getJob(uint256)");
async function readState() {
  const { data } = await pc.call({ to: ESCROW, data: "0x" + SEL.slice(2) + JOB.toString(16).padStart(64, "0") });
  const h = data.slice(2);
  return { status: Number(BigInt("0x" + h.slice(128, 192))), budget: BigInt("0x" + h.slice(448, 512)) };
}
async function sendTx(p) {
  const hash = await wc.sendTransaction({ ...p, gasPrice });
  return await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

let funded = false;
const st = ["Open","Funded","Submitted","Completed","Rejected","Expired"];
for (let i = 0; i < 170; i++) { // ~34 min máx
  let s;
  try { s = await readState(); } catch (e) { console.log("read err, retry"); await new Promise(r=>setTimeout(r,15000)); continue; }
  console.log(`[${new Date().toISOString().slice(11,19)}] poll ${i}: ${st[s.status]} budget=${s.budget}`);

  if (s.status === 0 && s.budget > 0n && !funded) {
    const a = await sendTx({ to: USDC, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [ESCROW, AMT] }) });
    console.log("approve:", a.status, a.transactionHash);
    const f = await sendTx({ to: ESCROW, data: encodeFunctionData({ abi: parseAbi(["function fund(uint256,address,uint256,bytes)"]), functionName: "fund", args: [JOB, USDC, AMT, "0x"] }) });
    console.log("fund:", f.status, f.transactionHash);
    funded = true;
    fs.writeFileSync("/home/ubuntu/defigent-data/job23_funded.txt", f.transactionHash);
  }
  if (s.status === 2) {
    const c = await sendTx({ to: ESCROW, data: encodeFunctionData({ abi: parseAbi(["function complete(uint256,bytes32,bytes)"]), functionName: "complete", args: [JOB, DIGEST, "0x"] }) });
    console.log("complete:", c.status, c.transactionHash);
    if (c.status === "success") {
      fs.writeFileSync("/home/ubuntu/defigent-data/job23_completed.txt", c.transactionHash);
      // outbox: informar del cierre + attestation
      const { default: uuid } = await import("node:crypto");
      const line = JSON.stringify({
        contextId: "t-em-438661c3-19ad19af",
        text: `CYCLE COMPLETE — job 23 settled: your worker's digest matched, complete() went through (tx ${c.transactionHash}), 0.10 USDC paid out to 0x50D3...9013, and the reputation hook wrote giveFeedback(10419, value=10, tags erc-8183-job/escrow-settled) on the Monad Reputation Registry — agentId 10419 now has on-chain proof of a real paid job, attested by the escrow itself. Read it back with readAllFeedback(10419). This is the full Defigent loop: A2A thread -> ERC-8183 escrow -> ERC-8004 reputation. GG — Defigent`,
        state: "completed",
        replyId: `cycle23-${uuid.randomUUID().slice(0,8)}`,
      });
      fs.appendFileSync("/home/ubuntu/defigent-data/defigent_outbox.jsonl", line + "\n");
      console.log("outbox: mensaje de cierre escrito");
    }
    break;
  }
  if (s.status >= 3) { console.log("estado terminal:", st[s.status]); break; }
  await new Promise((r) => setTimeout(r, 12000));
}
console.log("watcher terminado");