// Payer test: connect to Defigent MCP server (stdio), call free tool, then paid tool with autoPayment.
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import os from "os";

const env = fs.readFileSync(os.homedir() + "/.hermes/.env", "utf8");
const key = env.split("\n").find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).split("=", 2)[1].trim();
const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
console.error("payer:", account.address);

const transport = new StdioClientTransport({
  command: "node",
  args: [os.homedir() + "/defigent-mcp/server.mjs"],
});

const client = createx402MCPClient({
  name: "defigent-self-test",
  version: "1.0.0",
  schemes: [{ network: "eip155:143", client: new ExactEvmScheme(account) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => {
    const a = paymentRequired?.accepts?.[0];
    console.error(`payment requested: ${a?.amount} -> ${a?.payTo}`);
    return true; // auto-approve $0.001
  },
});
await client.connect(transport);

const info = await client.callTool("defigent_info", {});
console.log("FREE TOOL:", info.content[0].text.slice(0, 200));

const res = await client.callTool("defigent_digest", {
  address: account.address,
});
console.log("PAID TOOL RESULT:", res.content?.[0]?.text || JSON.stringify(res).slice(0, 400));
if (res.paymentMade) console.log("PAYMENT SETTLED:", res.paymentResponse?.transaction);
process.exit(0);
