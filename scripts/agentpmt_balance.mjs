// Verificación de saldo AgentPMT — EIP-191 wallet-auth (spec: action:balance)
import { createHash, randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { format } from "node:util";
import fs from "fs";

const API = "https://www.agentpmt.com";
const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);

// 1) session nonce
const sRes = await fetch(`${API}/api/external/auth/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ wallet_address: account.address }),
});
const sJson = await sRes.json();
const sessionNonce = sJson.session_nonce ?? sJson.sessionNonce ?? sJson.data?.session_nonce;
if (!sessionNonce) { console.log("session error:", sRes.status, JSON.stringify(sJson).slice(0, 300)); process.exit(1); }

// 2) firmar mensaje de balance
const requestId = `balance-${randomUUID()}`;
const signMessage = [
  "agentpmt-external",
  `wallet:${account.address.toLowerCase()}`,
  `session:${sessionNonce}`,
  `request:${requestId}`,
  "action:balance",
  "product:-",
  "payload:",
].join("\n");
const signature = await account.signMessage({ message: signMessage });

// 3) consultar saldo
const bRes = await fetch(`${API}/api/external/credits/balance`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    wallet_address: account.address,
    session_nonce: sessionNonce,
    request_id: requestId,
    signature,
  }),
});
console.log("balance HTTP:", bRes.status);
const bJson = await bRes.json().catch(() => ({}));
console.log(JSON.stringify(bJson, null, 2).slice(0, 800));