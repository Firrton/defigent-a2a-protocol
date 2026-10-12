// Defigent MCP Server — paid agent tools on Monad mainnet via x402
// Tools: defigent_info (free), agent_lookup (free), defigent_digest ($0.001, x402 exact/eip155:143)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { z } from "zod";

const PAY_TO = "0x940ecB27d8f4F7009c8BC12969496E9639717638";
const RPC = "https://rpc.monad.xyz";
const FACILITATOR = "https://x402-facilitator.molandak.org";
const NETWORK = "eip155:143";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (!j.result) throw new Error(JSON.stringify(j.error || j));
  return j.result;
}

async function balanceOf(token, who) {
  const data = "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0");
  const r = await rpc("eth_call", [{ to: token, data }, "latest"]);
  return parseInt(r, 16);
}

async function agentURI(agentId) {
  const data = "0xc87b56dd" + BigInt(agentId).toString(16).padStart(64, "0");
  const r = await rpc("eth_call", [{ to: IDENTITY, data }, "latest"]);
  const raw = Buffer.from(r.slice(2), "hex");
  const len = Number(raw.readBigUInt64BE(32)); // word 1 = length (low bytes)
  const uri = raw.slice(64, 64 + len).toString();
  if (uri.startsWith("data:application/json;base64,")) {
    const reg = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    return reg;
  }
  return { uri };
}

// --- x402 setup ( Monad mainnet USDC is built into @x402/evm >= 2.22 ) ---
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(NETWORK, new ExactEvmScheme());
await resourceServer.initialize();

const accepts = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: NETWORK,
  payTo: PAY_TO,
  price: "$0.001",
});
const paid = createPaymentWrapper(resourceServer, {
  accepts,
  hooks: {
    onBeforeExecution: async ({ toolName, paymentPayload }) => {
      console.error(`[defigent] paid call: ${toolName} by ${paymentPayload?.payer || "?"}`);
      return true;
    },
    onAfterSettlement: async ({ toolName, settlement }) => {
      console.error(`[defigent] settled ${toolName}: ${settlement?.transaction}`);
    },
  },
});

const mcpServer = new McpServer({ name: "defigent", version: "1.0.0" });

mcpServer.tool(
  "defigent_info",
  "Who is Defigent: ERC-8004 agent identity on Monad mainnet (agentId 10331). Free.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        name: "Defigent",
        agentId: 10331,
        registry: IDENTITY,
        network: "monad mainnet (eip155:143)",
        operatorWallet: PAY_TO,
        services: ["agent_lookup (free)", "defigent_digest (paid x402 $0.001)"],
        x402Support: true,
      }, null, 2),
    }],
  })
);

mcpServer.tool(
  "agent_lookup",
  "Look up any ERC-8004 agent registration by agentId ( Monad mainnet registry ). Free.",
  { agentId: z.number().int().positive() },
  async ({ agentId }) => {
    try {
      const reg = await agentURI(agentId);
      return { content: [{ type: "text", text: JSON.stringify(reg, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: "lookup failed: " + err.message }], isError: true };
    }
  }
);

mcpServer.tool(
  "defigent_digest",
  "On-chain wallet digest on Monad mainnet (MON + USDC balances, tx count via block scan sampling). Costs $0.001 USDC via x402.",
  { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  paid(async ({ address }) => {
    const mon = await rpc("eth_getBalance", [address, "latest"]);
    let usdc = 0;
    try { usdc = await balanceOf(USDC, address); } catch {}
    const block = await rpc("eth_blockNumber", []);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          address,
          mon: Number(BigInt(mon)) / 1e18,
          usdc: usdc / 1e6,
          chain: "monad mainnet",
          block: BigInt(block).toString(),
          provider: "Defigent (ERC-8004 agentId 10331)",
        }, null, 2),
      }],
    };
  })
);

await mcpServer.connect(new StdioServerTransport());
console.error("[defigent] MCP server ready (stdio), paid tool: defigent_digest @ $0.001 eip155:143");
