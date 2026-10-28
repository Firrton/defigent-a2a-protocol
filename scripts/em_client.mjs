// Cliente ERC-8128 para Execution Market — firma por request (EIP-191 sobre signature base)
// Spec: https://execution.market/skill/reference/signing.md (label eth, keyid erc8128:{chain}:{wallet}, alg=eip191)
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const API = "https://api.execution.market";
const CHAIN = 8453; // payment_network default base
const lines = fs.readFileSync("/home/ubuntu/.hermes/.env", "utf8").split("\n");
const rawKey = lines.find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).slice("DEFIGENT_PRIVATE_KEY=".length).trim();
export const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);

async function getNonce() {
  for (const p of ["/api/v1/auth/erc8128/nonce", "/api/v1/auth/nonce"]) {
    try {
      const r = await fetch(API + p);
      if (r.ok) {
        const j = await r.json();
        const n = j.nonce ?? j.data?.nonce;
        if (n) return n;
      }
    } catch {}
  }
  throw new Error("no nonce endpoint");
}

export async function signHeaders(method, url, body) {
  const nonce = await getNonce();
  const u = new URL(url);
  const created = Math.floor(Date.now() / 1000);
  const covered = ["@method", "@authority", "@path"];
  let contentDigest = null;
  if (u.search) covered.push("@query");
  if (body != null) {
    const b64 = createHash("sha256").update(body).digest("base64");
    contentDigest = `sha-256=:${b64}:`;
    covered.push("content-digest");
  }
  const keyid = `erc8128:${CHAIN}:${account.address.toLowerCase()}`;
  const sp =
    `(${covered.map((c) => `"${c}"`).join(" ")})` +
    `;created=${created};expires=${created + 300};nonce="${nonce}";keyid="${keyid}";alg="eip191"`;
  const base = [];
  for (const c of covered) {
    if (c === "@method") base.push(`"@method": ${method.toUpperCase()}`);
    else if (c === "@authority") base.push(`"@authority": ${u.host}`);
    else if (c === "@path") base.push(`"@path": ${u.pathname}`);
    else if (c === "@query") base.push(`"@query": ?${u.search.slice(1)}`);
    else if (c === "content-digest") base.push(`"content-digest": ${contentDigest}`);
  }
  base.push(`"@signature-params": ${sp}`);
  const sig = await account.signMessage({ message: base.join("\n") });
  const headers = {
    Signature: `eth=:${Buffer.from(sig.slice(2), "hex").toString("base64")}:`,
    "Signature-Input": `eth=${sp}`,
  };
  if (contentDigest) headers["Content-Digest"] = contentDigest;
  return headers;
}

export async function emFetch(method, path, body) {
  const url = API + path;
  const bodyStr = body != null ? JSON.stringify(body) : null;
  const auth = await signHeaders(method, url, bodyStr);
  const headers = { ...auth, "User-Agent": "Mozilla/5.0" };
  if (bodyStr) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method, headers, body: bodyStr });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = txt.slice(0, 300); }
  return { status: r.status, json: j };
}

// Self-test si se corre directo
if (process.argv[1] && process.argv[1].includes("em_client")) {
  const test = await emFetch("GET", "/api/v1/workers/me");
  console.log("GET /api/v1/workers/me →", test.status, JSON.stringify(test.json).slice(0, 300));
}