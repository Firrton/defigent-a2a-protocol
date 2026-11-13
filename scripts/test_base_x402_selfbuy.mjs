// Test E2E: Defigent compra su PROPIO digest pagando x402 en BASE (eip155:8453)
// Ejercita: 402 → PAYMENT-REQUIRED → firma EIP-3009 (USDC Base) → verify/settle vía PayAI → digest
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const keyLine = lines.find(l => l.startsWith("DEFIGENT_PRIVATE_KEY="));
const rawKey = keyLine.slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const wallet = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : ("0x" + rawKey));
const signer = { address: wallet.address, signTypedData: (params) => wallet.signTypedData(params) };
const client = new x402Client((_v, reqs) => reqs.find(r => r.network === "eip155:8453") || reqs[0]);
client.register("eip155:8453", new ExactEvmScheme(signer));

const fetchWithPay = wrapFetchWithPayment(fetch, client);
const t0 = Date.now();
const res = await fetchWithPay("http://localhost:8080/digest?address=0x940ecB27d8f4F7009c8BC12969496E9639717638");
console.log("status:", res.status, "| ms:", Date.now() - t0);
const body = await res.text();
console.log("body:", body.slice(0, 400));
const pr = res.headers.get("payment-response");
if (pr) {
  const p = JSON.parse(Buffer.from(pr, "base64").toString());
  console.log("settlement:", JSON.stringify(p).slice(0, 300));
}
