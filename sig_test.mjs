// E2E test of A2A v2: signed message -> task -> /tasks read -> verification
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import os from "os";

const env = fs.readFileSync(os.homedir() + "/.hermes/.env", "utf8");
const key = env.split("\n").find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).split("=", 2)[1].trim();
const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
console.log("sender:", account.address);

const now = Date.now();
const nonce = "a2a-" + Math.random().toString(36).slice(2);
const authMessage = {
  inboxAgentId: 10331n,
  senderAddress: account.address,
  timestamp: BigInt(now),
  nonce,
};
const domain = { name: "Defigent Inbox", version: "1", chainId: 143, verifyingContract: "0x940ecB27d8f4F7009c8BC12969496E9639717638" };
const types = { DefigentInboxAuth: [
  { name: "inboxAgentId", type: "uint256" },
  { name: "senderAddress", type: "address" },
  { name: "timestamp", type: "uint256" },
  { name: "nonce", type: "string" },
]};
const sig = account.signTypedData({ domain, types, primaryType: "DefigentInboxAuth", message: authMessage });

const payload = {
  jsonrpc: "2.0", id: 1, method: "message/send",
  params: {
    message: { role: "agent", parts: [{ type: "text", text: "Signed test: Defigent self-check" }], messageId: "sig-e2e-" + Date.now(), kind: "message" },
    auth: { address: account.address, signature: sig, timestamp: now, nonce },
  },
};
const res = await fetch("http://localhost:8080/inbox", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const r = await res.json();
console.log("reply:", JSON.stringify(r.result, null, 2).slice(0, 400));

// verify the task with the returned contextId
const ctxId = r.result?.contextId;
if (ctxId) {
  const tr = await fetch(`http://localhost:8080/tasks/${ctxId}`);
  const t = await tr.json();
  console.log("task:", t.task, "| history entries:", t.history.length);
}
