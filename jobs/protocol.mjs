// Typed jobs protocol v1: zod schemas for the defigent.job.* DataParts, detection, legacy offer_schema_v1 conversion and canonical JSON.
import crypto from "node:crypto";
import { getAddress, keccak256, toBytes } from "viem";
import { z } from "zod";
import { tokenBySymbol } from "./config.mjs";

export const EXT_URI = "https://w3id.org/defigent/a2a/erc8183-jobs/v1";
export const KEY_PREFIX = "defigent.job.";
export const NOTICE_NAMES = Object.freeze(["created", "budget_set", "funded", "submitted", "completed", "rejected", "expired"]);
export const NAMES = Object.freeze(["offer", "accept", "decline", ...NOTICE_NAMES, "query", "status", "error"]);

export function fullKey(name) {
  return KEY_PREFIX + name;
}

const UINT256_MAX = 2n ** 256n - 1n;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const JOB_ID_RE = /^[1-9][0-9]*$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const uint256 = (re, message) =>
  z.string().regex(re, message).refine((x) => !re.test(x) || BigInt(x) <= UINT256_MAX, "must fit in a uint256");

const Amount = uint256(AMOUNT_RE, "must be a decimal string of base units without leading zeros");
const JobId = uint256(JOB_ID_RE, "must be a decimal string of a uint256 >= 1");
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address").transform((a) => getAddress(a));
const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex value").transform((h) => h.toLowerCase());
const OfferId = z.string().regex(/^of_[A-Za-z0-9]{10}$/, "must be of_ followed by 10 characters [A-Za-z0-9]");
const AgentId = z.number().int().nonnegative();
const UnixSeconds = z.number().int().positive();

const offer = z.object({
  offerId: OfferId,
  side: z.enum(["client", "provider"]),
  service: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a lowercase slug [a-z0-9-] of at most 64 characters"),
  description: z.string().min(1).max(2000),
  price: z.object({ amount: Amount, token: Address, decimals: z.number().int().min(0).max(18), symbol: z.string().min(1).max(16) }),
  settlement: z.object({ chainId: z.literal(143), escrow: Address }),
  deliverable: z.object({ mediaType: z.string().min(1).max(100), acceptance: z.enum(["operator", "hash"]), expectedHash: Hex32.optional() }),
  providerSteps: z.array(z.string().min(1).max(64)).max(16).optional(),
  gas: z.object({ providerTxs: z.number().int().min(0).max(100), grant: Amount.nullable() }).optional(),
  from: z.object({ address: Address, agentId: AgentId }).optional(),
  to: z.object({ agentId: AgentId }).optional(),
  replyTo: z.object({ url: z.url({ protocol: /^https?$/ }).max(2048), contextId: z.string().min(1).max(256) }).optional(),
  expiresAt: UnixSeconds,
});

const notice = z.object({ jobId: JobId, txHash: Hex32.optional() });

const SCHEMAS = {
  offer,
  accept: z.object({ offerId: OfferId, party: z.object({ address: Address, agentId: AgentId }) }),
  decline: z.object({ offerId: OfferId, reason: z.enum(["price", "scope", "expired", "capacity", "no_wallet", "other"]), note: z.string().max(500).optional() }),
  created: notice.extend({ offerId: OfferId.optional() }),
  budget_set: notice,
  funded: notice,
  submitted: notice.extend({
    deliverable: z.object({ hash: Hex32, uri: z.string().min(1).max(2048).optional(), mediaType: z.string().min(1).max(100).optional() }),
  }),
  completed: notice,
  rejected: notice,
  expired: notice,
  query: z.object({ offerId: OfferId.optional(), jobId: JobId.optional() })
    .refine((q) => (q.offerId === undefined) !== (q.jobId === undefined), { message: "exactly one of offerId or jobId is required", path: ["offerId"] }),
  // Peers' status and error replies are only logged, so they are not checked beyond being objects.
  status: z.looseObject({}),
  error: z.looseObject({}),
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function detectTyped(dataParts) {
  const found = [];
  for (const part of dataParts) {
    if (!isPlainObject(part)) continue;
    for (const key of Object.keys(part)) if (key.startsWith(KEY_PREFIX)) found.push([key, part[key]]);
  }
  if (found.length > 1) return { kind: "invalid", field: "data", detail: `a typed message carries exactly one ${KEY_PREFIX}* key, found ${found.length}` };
  if (found.length === 1) return { kind: "typed", name: found[0][0].slice(KEY_PREFIX.length), body: found[0][1] };
  // Same test as the offer_schema_v1 detection in http_server.mjs.
  const legacy = dataParts.find((d) => d?.intent === "offer" && d?.service && d?.price);
  return legacy ? { kind: "legacy", body: legacy } : { kind: "none" };
}

export function parseTyped(name, body) {
  if (!Object.hasOwn(SCHEMAS, name)) return { ok: false, unsupported: true };
  const r = SCHEMAS[name].safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  return { ok: false, field: issue.path.join("."), detail: issue.message };
}

// Decimal price ("1.25") to base units of `decimals`, or null if it is not an exact non-negative decimal.
function toBaseUnits(price, decimals) {
  const text = typeof price === "number" && Number.isFinite(price) ? String(price) : price;
  const m = typeof text === "string" ? /^([0-9]+)(?:\.([0-9]+))?$/.exec(text) : null;
  if (!m || (m[2] ?? "").length > decimals) return null;
  return BigInt(m[1] + (m[2] ?? "").padEnd(decimals, "0")).toString();
}

// offer_schema_v1 {intent:"offer", service, price, asset?, expiry? (ms), terms?} → a provider-side defigent.job.offer.
export function normalizeLegacyOffer(body, config, { newId = newOfferId, now = Math.floor(Date.now() / 1000) } = {}) {
  const asset = body.asset ?? "USDC";
  const token = tokenBySymbol(config, asset);
  if (!token) return { ok: false, field: "asset", detail: `unknown asset ${JSON.stringify(asset)}` };
  const amount = toBaseUnits(body.price, token.decimals);
  if (amount === null) return { ok: false, field: "price", detail: `must be a non-negative decimal with at most ${token.decimals} decimals` };
  let expiresAt = now + config.minOfferTtlSeconds;
  if (body.expiry !== undefined && body.expiry !== null) {
    if (!Number.isFinite(body.expiry) || body.expiry < 0) return { ok: false, field: "expiry", detail: "must be a Unix time in milliseconds" };
    expiresAt = Math.floor(body.expiry / 1000);
  }
  return parseTyped("offer", {
    offerId: newId(),
    side: "provider",
    service: body.service,
    description: body.terms ?? body.service,
    price: { amount, token: token.address, decimals: token.decimals, symbol: token.symbol },
    settlement: { chainId: config.chainId, escrow: config.escrow },
    deliverable: { mediaType: "application/octet-stream", acceptance: "operator" },
    expiresAt,
  });
}

export function newOfferId() {
  let id = "";
  while (id.length < 10) {
    // 248 = 4 * 62: bytes at or above it are dropped so every character is equally likely.
    for (const b of crypto.randomBytes(16)) if (b < 248 && id.length < 10) id += BASE62[b % 62];
  }
  return `of_${id}`;
}

// Sorted keys, no whitespace. Refuses values JSON cannot carry faithfully.
export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not JSON`);
  }
}

export function termsHash(offer) {
  return keccak256(toBytes(canonicalJson(offer)));
}

export function jobDescription(offer) {
  return canonicalJson({ v: 1, offerId: offer.offerId, terms: termsHash(offer) });
}

const JobDescription = z.object({ v: z.literal(1), offerId: OfferId, terms: Hex32 });

export function parseJobDescription(text) {
  if (typeof text !== "string") return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = JobDescription.safeParse(raw);
  return r.success ? { v: 1, offerId: r.data.offerId, terms: r.data.terms } : null;
}

export function jobsJsonSchema() {
  const parts = NAMES.map((name) => z.object({ [fullKey(name)]: SCHEMAS[name] }));
  return z.toJSONSchema(z.union(parts).meta({ title: "Defigent typed job DataPart", description: `Exactly one ${KEY_PREFIX}* key per DataPart (${EXT_URI}).` }), { io: "input" });
}
