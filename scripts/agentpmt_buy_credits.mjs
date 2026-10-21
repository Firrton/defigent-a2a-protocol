// Compra de 500 créditos AgentPMT pagando x402 v2 con USDC de Base (EIP-3009)
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find(l => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const wallet = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : ("0x" + rawKey));
const signer = { address: wallet.address, signTypedData: (p) => wallet.signTypedData(p) };

const client = new x402Client((_v, reqs) =>
  reqs.find(r => r.network === "eip155:8453" && (r.asset || "").toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") ||
  reqs.find(r => r.network === "eip155:8453") || reqs[0]);
client.setSpendControls({ maxAmountPerPayment: "$5" }); // compra AgentPMT aprobada (pack mínimo $5)
client.register("eip155:8453", new ExactEvmScheme(signer));

const fetchWithPay = wrapFetchWithPayment(fetch, client);
const body = { wallet_address: wallet.address, credits: 500, payment_method: "x402" };
const res = await fetchWithPay("https://www.agentpmt.com/api/external/credits/purchase", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
console.log("status:", res.status);
const txt = await res.text();
console.log("body:", txt.slice(0, 500));
