// Loads data/jobs-config.json and applies env overrides for the typed jobs protocol.
import fs from "node:fs";
import { getAddress, isAddress } from "viem";

const DEFAULT_FILE = new URL("../data/jobs-config.json", import.meta.url);
const ADDRESS_FIELDS = ["escrow", "identityRegistry", "client", "evaluator", "hook"];
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

function fail(field, msg) {
  throw new Error(`jobs-config: ${field} ${msg}`);
}

function address(field, value) {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) fail(field, `is not a valid address: ${JSON.stringify(value)}`);
  return getAddress(value);
}

function int(field, value, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(field, `must be an integer >= ${min}: ${JSON.stringify(value)}`);
  return value;
}

function envInt(env, name, min) {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!AMOUNT_RE.test(raw)) fail(name, `must be a decimal integer >= ${min}: ${JSON.stringify(raw)}`);
  return int(name, Number(raw), min);
}

function amount(field, value) {
  if (typeof value !== "string" || !AMOUNT_RE.test(value)) fail(field, `must be a decimal integer string: ${JSON.stringify(value)}`);
  return BigInt(value);
}

function url(field, value) {
  try {
    return new URL(value).href;
  } catch {
    fail(field, `is not a valid URL: ${JSON.stringify(value)}`);
  }
}

export function loadJobsConfig({ file = DEFAULT_FILE, env = process.env } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail("file", `cannot be read as JSON: ${e.message}`);
  }

  const config = { chainId: int("chainId", raw.chainId, 1), agentId: int("agentId", raw.agentId, 0) };
  for (const f of ADDRESS_FIELDS) config[f] = address(f, raw[f]);

  if (!raw.tokens || typeof raw.tokens !== "object") fail("tokens", "must be an object");
  config.tokens = {};
  for (const [symbol, t] of Object.entries(raw.tokens)) {
    config.tokens[symbol] = { address: address(`tokens.${symbol}.address`, t?.address), decimals: int(`tokens.${symbol}.decimals`, t?.decimals) };
  }

  const caps = raw.caps ?? {};
  config.caps = {
    maxOfferAmount: amount("caps.maxOfferAmount", caps.maxOfferAmount),
    maxOpenOffersPerAgent: int("caps.maxOpenOffersPerAgent", caps.maxOpenOffersPerAgent),
    maxCreateJobPerDay: int("caps.maxCreateJobPerDay", caps.maxCreateJobPerDay),
  };

  config.minOfferTtlSeconds = int("minOfferTtlSeconds", raw.minOfferTtlSeconds);
  config.minWorkWindowSeconds = int("minWorkWindowSeconds", raw.minWorkWindowSeconds);
  config.rpcTimeoutMs = int("rpcTimeoutMs", raw.rpcTimeoutMs, 100);
  config.sweepMs = int("sweepMs", raw.sweepMs, 50);
  config.inboxUrl = url("inboxUrl", raw.inboxUrl);
  config.schemaUrl = url("schemaUrl", raw.schemaUrl);

  config.sweepMs = envInt(env, "DEFIGENT_JOBS_SWEEP_MS", 50) ?? config.sweepMs;
  config.rpcTimeoutMs = envInt(env, "DEFIGENT_JOBS_RPC_TIMEOUT_MS", 100) ?? config.rpcTimeoutMs;
  if (env.DEFIGENT_JOBS_HOOK) config.hook = address("DEFIGENT_JOBS_HOOK", env.DEFIGENT_JOBS_HOOK);

  return config;
}

function token(symbol, t) {
  return { symbol, address: t.address, decimals: t.decimals };
}

export function tokenByAddress(config, addr) {
  if (typeof addr !== "string") return null;
  const needle = addr.toLowerCase();
  for (const [symbol, t] of Object.entries(config.tokens)) if (t.address.toLowerCase() === needle) return token(symbol, t);
  return null;
}

export function tokenBySymbol(config, symbol) {
  const t = Object.hasOwn(config.tokens, symbol) ? config.tokens[symbol] : null;
  return t ? token(symbol, t) : null;
}
