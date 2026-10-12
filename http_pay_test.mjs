// Client test: pay $0.001 via x402 to Defigent HTTP endpoint (localhost).
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import os from "os";

const env = fs.readFileSync(os.homedir() + "/.hermes/.env", "utf8");
const key = env.split("\n").find((l) => l.startsWith("DEFIGENT_PRIVATE_KEY=")).split("=", 2)[1].trim();
const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);

const client = new x402Client().register("eip155:143", new ExactEvmScheme(account));
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch("http://localhost:8080/digest?address=0x940ecB27d8f4F7009c8BC12969496E9639717638");
console.log("status:", res.status);
console.log("body:", await res.text());
