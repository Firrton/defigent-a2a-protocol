// Pagar un paid-pass de Taifoon (mcp.digest, 0.008 USDC) vía x402 v2 con USDC de Base
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
client.setSpendControls({ maxAmountPerPayment: "$1" });
client.register("eip155:8453", new ExactEvmScheme(signer));

const fetchWithPay = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPay("https://coord.taifoon.dev/v1/x402/class/mcp.digest", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: { text: "defigent paid pass test", algorithm: "keccak256" } }),
});
console.log("status:", res.status);
const body = await res.text();
console.log("body:", body.slice(0, 500));
