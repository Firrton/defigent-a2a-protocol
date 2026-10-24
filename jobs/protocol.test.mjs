import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { loadJobsConfig } from "./config.mjs";
import {
  EXT_URI, KEY_PREFIX, NAMES, NOTICE_NAMES, fullKey, detectTyped, parseTyped, normalizeLegacyOffer, newOfferId,
  canonicalJson, termsHash, jobDescription, parseJobDescription, jobsJsonSchema,
} from "./protocol.mjs";

const cfg = loadJobsConfig({ env: {} });
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const ESCROW = "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65";
const A = "0x940ecB27d8f4F7009c8BC12969496E9639717638";
const OFFER_ID = "of_7Hq2kd9xTa";
const HASH = `0x${"ab".repeat(32)}`;

const validOffer = {
  offerId: OFFER_ID,
  side: "client",
  service: "a2a-conformance-probe",
  description: "Answer tasks/get for a random id with JSON-RPC error -32001 and return the raw response.",
  price: { amount: "250000", token: USDC, decimals: 6, symbol: "USDC" },
  settlement: { chainId: 143, escrow: ESCROW },
  deliverable: { mediaType: "application/json", acceptance: "operator" },
  providerSteps: ["setBudget", "submit"],
  gas: { providerTxs: 2, grant: null },
  to: { agentId: 10270 },
  replyTo: { url: "https://inbox.example/inbox", contextId: OFFER_ID },
  expiresAt: 1792800000,
};

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function offerWith(overrides) {
  const out = { ...validOffer };
  for (const [k, v] of Object.entries(overrides)) out[k] = isPlain(v) && isPlain(validOffer[k]) ? { ...validOffer[k], ...v } : v;
  return out;
}

test("exports the extension URI, the key prefix and the 13 names", () => {
  assert.equal(EXT_URI, "https://w3id.org/defigent/a2a/erc8183-jobs/v1");
  assert.equal(KEY_PREFIX, "defigent.job.");
  assert.deepEqual(NAMES, ["offer", "accept", "decline", "created", "budget_set", "funded", "submitted", "completed", "rejected", "expired", "query", "status", "error"]);
  assert.deepEqual(NOTICE_NAMES, ["created", "budget_set", "funded", "submitted", "completed", "rejected", "expired"]);
  assert.equal(fullKey("budget_set"), "defigent.job.budget_set");
});

test("detects exactly one defigent.job.* key and ignores arrays and plain parts", () => {
  assert.deepEqual(detectTyped([{ a: 1 }, ["x"]]), { kind: "none" });
  assert.equal(detectTyped([{ "defigent.job.query": { jobId: "42" } }]).name, "query");
  assert.equal(detectTyped([{ "defigent.job.query": {}, "defigent.job.accept": {} }]).kind, "invalid");
  assert.equal(detectTyped([{ "defigent.job.query": {} }, { "defigent.job.accept": {} }]).kind, "invalid");
  assert.deepEqual(detectTyped([{ "defigent.job.teleport": {} }]), { kind: "typed", name: "teleport", body: {} });
  assert.equal(detectTyped([{ intent: "offer", service: "s", price: "1.00" }]).kind, "legacy");
});

test("detection skips arrays, null and non-objects, and typed keys win over the legacy shape", () => {
  assert.deepEqual(detectTyped([[{ "defigent.job.query": { jobId: "1" } }], null, "defigent.job.query", 7]), { kind: "none" });
  assert.deepEqual(detectTyped([{ intent: "offer", service: "s", price: "1" }, { "defigent.job.query": { jobId: "1" } }]),
    { kind: "typed", name: "query", body: { jobId: "1" } });
  assert.deepEqual(detectTyped([{ intent: "offer", service: "s" }]), { kind: "none" });
  assert.deepEqual(detectTyped([{ intent: "offer", service: "s", price: "1" }]), { kind: "legacy", body: { intent: "offer", service: "s", price: "1" } });
  assert.deepEqual(detectTyped([{ "defigent.job.query": {}, "defigent.job.accept": {} }]),
    { kind: "invalid", field: "data", detail: "a typed message carries exactly one defigent.job.* key, found 2" });
});

test("unknown names are unsupported, not invalid", () =>
  assert.deepEqual(parseTyped("teleport", {}), { ok: false, unsupported: true }));

test("a valid offer parses and keeps its fields", () => {
  const r = parseTyped("offer", validOffer);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, validOffer);
});

test("unknown fields are dropped", () => {
  const r = parseTyped("offer", { ...validOffer, extra: 1, price: { ...validOffer.price, junk: true } });
  assert.deepEqual(r.value, validOffer);
});

test("rejects malformed amounts and normalizes addresses", () => {
  for (const amount of ["0250000", "2.5", "-1", (2n ** 256n).toString(), ""])
    assert.equal(parseTyped("offer", offerWith({ price: { amount } })).ok, false, amount);
  assert.equal(parseTyped("offer", offerWith({ price: { amount: (2n ** 256n - 1n).toString() } })).ok, true);
  assert.equal(parseTyped("offer", offerWith({ price: { token: USDC.toLowerCase() } })).value.price.token, USDC);
  assert.equal(parseTyped("offer", offerWith({ settlement: { escrow: ESCROW.toLowerCase() } })).value.settlement.escrow, ESCROW);
});

test("offer field rules: side, service, chainId, decimals, acceptance and lengths", () => {
  const bad = {
    side: offerWith({ side: "evaluator" }),
    service: offerWith({ service: "Has Spaces" }),
    description: offerWith({ description: "" }),
    "settlement.chainId": offerWith({ settlement: { chainId: 1 } }),
    "price.decimals": offerWith({ price: { decimals: 19 } }),
    "price.symbol": offerWith({ price: { symbol: "X".repeat(17) } }),
    "deliverable.acceptance": offerWith({ deliverable: { acceptance: "vibes" } }),
    "deliverable.mediaType": offerWith({ deliverable: { mediaType: "a".repeat(101) } }),
    "gas.grant": offerWith({ gas: { grant: "1.5" } }),
    expiresAt: offerWith({ expiresAt: undefined }),
    "replyTo.url": offerWith({ replyTo: { url: "javascript:alert(1)" } }),
  };
  for (const [field, body] of Object.entries(bad)) assert.equal(parseTyped("offer", body).field, field, field);
  assert.equal(parseTyped("offer", offerWith({ description: "x".repeat(2001) })).field, "description");
  assert.equal(parseTyped("offer", offerWith({ service: "a".repeat(65) })).field, "service");
  assert.equal(parseTyped("offer", offerWith({ gas: { grant: "1000" } })).value.gas.grant, "1000");
});

test("optional offer parts may be absent", () => {
  const { providerSteps, gas, to, replyTo, ...bare } = validOffer;
  const r = parseTyped("offer", { ...bare, from: { address: A.toLowerCase(), agentId: 10331 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.from, { address: A, agentId: 10331 });
  assert.equal("gas" in r.value, false);
});

test("validation errors name the field path", () =>
  assert.equal(parseTyped("accept", { offerId: "of_short", party: { address: A, agentId: 1 } }).field, "offerId"));

test("accept and decline follow their schemas", () => {
  assert.deepEqual(parseTyped("accept", { offerId: OFFER_ID, party: { address: A.toLowerCase(), agentId: 10270 } }).value,
    { offerId: OFFER_ID, party: { address: A, agentId: 10270 } });
  assert.equal(parseTyped("accept", { offerId: OFFER_ID, party: { address: "0x123", agentId: 1 } }).field, "party.address");
  assert.equal(parseTyped("accept", { offerId: OFFER_ID, party: { address: A, agentId: -1 } }).field, "party.agentId");
  assert.deepEqual(parseTyped("decline", { offerId: OFFER_ID, reason: "price", note: "too low" }).value, { offerId: OFFER_ID, reason: "price", note: "too low" });
  assert.equal(parseTyped("decline", { offerId: OFFER_ID, reason: "bored" }).field, "reason");
  assert.equal(parseTyped("decline", { offerId: OFFER_ID, reason: "other", note: "n".repeat(501) }).field, "note");
});

test("notices carry a jobId and an optional txHash; submitted adds the deliverable; created may name the offer", () => {
  for (const name of NOTICE_NAMES.filter((n) => n !== "submitted")) {
    assert.deepEqual(parseTyped(name, { jobId: "42" }).value, { jobId: "42" }, name);
    assert.deepEqual(parseTyped(name, { jobId: "42", txHash: HASH }).value, { jobId: "42", txHash: HASH }, name);
  }
  for (const jobId of ["0", "042", "x", 42, (2n ** 256n).toString()]) assert.equal(parseTyped("funded", { jobId }).field, "jobId", String(jobId));
  assert.equal(parseTyped("funded", { jobId: "42", txHash: "0x1234" }).field, "txHash");
  assert.deepEqual(parseTyped("created", { jobId: "42", offerId: OFFER_ID }).value, { jobId: "42", offerId: OFFER_ID });
  assert.equal(parseTyped("created", { jobId: "42", offerId: "of_bad" }).field, "offerId");
  const deliverable = { hash: HASH, uri: "https://x.example/d.json", mediaType: "application/json" };
  assert.deepEqual(parseTyped("submitted", { jobId: "42", deliverable }).value, { jobId: "42", deliverable });
  assert.equal(parseTyped("submitted", { jobId: "42" }).field, "deliverable");
  assert.equal(parseTyped("submitted", { jobId: "42", deliverable: { hash: HASH, uri: "u".repeat(2049) } }).field, "deliverable.uri");
});

test("query needs exactly one of offerId or jobId", () => {
  assert.equal(parseTyped("query", {}).ok, false);
  assert.equal(parseTyped("query", { offerId: OFFER_ID, jobId: "42" }).ok, false);
  assert.deepEqual(parseTyped("query", { offerId: OFFER_ID }).value, { offerId: OFFER_ID });
  assert.deepEqual(parseTyped("query", { jobId: "42" }).value, { jobId: "42" });
});

test("status and error are only checked to be objects", () => {
  assert.deepEqual(parseTyped("status", { anything: [1] }).value, { anything: [1] });
  assert.deepEqual(parseTyped("error", { code: "x", whatever: true }).value, { code: "x", whatever: true });
  assert.equal(parseTyped("status", "nope").ok, false);
});

test("legacy offer_schema_v1 becomes a provider-side offer in base units and seconds", () => {
  const r = normalizeLegacyOffer({ intent: "offer", service: "lint", price: "1.25", asset: "USDC", expiry: 1792800000000, terms: "lint your card" }, cfg, { newId: () => "of_AAAAAAAAAA" });
  assert.deepEqual([r.value.side, r.value.price.amount, r.value.expiresAt, r.value.description], ["provider", "1250000", 1792800000, "lint your card"]);
  assert.deepEqual(r.value.price, { amount: "1250000", token: USDC, decimals: 6, symbol: "USDC" });
  assert.deepEqual(r.value.settlement, { chainId: 143, escrow: ESCROW });
  assert.equal(r.value.offerId, "of_AAAAAAAAAA");
  assert.equal(r.value.service, "lint");
});

test("legacy defaults: USDC, description from service, expiry from minOfferTtlSeconds", () => {
  const r = normalizeLegacyOffer({ intent: "offer", service: "price-feed", price: "2" }, cfg, { newId: () => "of_BBBBBBBBBB", now: 1700000000 });
  assert.deepEqual([r.value.price.amount, r.value.price.symbol, r.value.description, r.value.expiresAt], ["2000000", "USDC", "price-feed", 1700000000 + 86400]);
});

test("a legacy offer with an unknown asset is invalid", () =>
  assert.equal(normalizeLegacyOffer({ intent: "offer", service: "x", price: "1", asset: "DOGE" }, cfg).field, "asset"));

test("legacy prices and expiries that do not convert are invalid", () => {
  for (const price of ["1.0000001", "-1", "1e3", "abc", "1,5"])
    assert.equal(normalizeLegacyOffer({ intent: "offer", service: "x", price }, cfg).field, "price", price);
  assert.equal(normalizeLegacyOffer({ intent: "offer", service: "x", price: 1.5 }, cfg).value.price.amount, "1500000");
  assert.equal(normalizeLegacyOffer({ intent: "offer", service: "x", price: "1", expiry: "soon" }, cfg).field, "expiry");
  assert.equal(normalizeLegacyOffer({ intent: "offer", service: "Not A Slug", price: "1" }, cfg).field, "service");
});

test("newOfferId has the of_ + 10 base62 shape and varies", () => {
  const ids = new Set(Array.from({ length: 50 }, newOfferId));
  for (const id of ids) assert.match(id, /^of_[A-Za-z0-9]{10}$/);
  assert.equal(ids.size, 50);
});

test("canonicalJson sorts keys recursively and termsHash ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3] } }), '{"a":{"c":[3],"d":2},"b":1}');
  assert.equal(termsHash({ a: 1, b: 2 }), termsHash({ b: 2, a: 1 }));
  assert.equal(termsHash({ a: 1 }), keccak256(toBytes('{"a":1}')));
});

test("canonicalJson refuses bigint and undefined", () => {
  assert.throws(() => canonicalJson({ a: 1n }), /bigint/);
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => canonicalJson([undefined]), /undefined/);
  assert.equal(canonicalJson(["x", null, true, 1.5]), '["x",null,true,1.5]');
});

test("a parsed offer hashes the same as its source", () =>
  assert.equal(termsHash(parseTyped("offer", validOffer).value), termsHash(validOffer)));

test("jobDescription round-trips and plain descriptions are not ours", () => {
  assert.deepEqual(parseJobDescription(jobDescription(validOffer)), { v: 1, offerId: validOffer.offerId, terms: termsHash(validOffer) });
  assert.equal(parseJobDescription("dogfood job"), null);
});

test("jobDescription is the canonical {offerId,terms,v} JSON", () => {
  assert.equal(jobDescription(validOffer), `{"offerId":"${OFFER_ID}","terms":"${termsHash(validOffer)}","v":1}`);
  for (const text of ['{"v":2,"offerId":"of_7Hq2kd9xTa","terms":"0x00"}', '{"v":1,"offerId":"of_x","terms":"' + HASH + '"}', "[]", "null", undefined])
    assert.equal(parseJobDescription(text), null, String(text));
});

test("jobsJsonSchema covers the 13 keys", () => {
  const text = JSON.stringify(jobsJsonSchema());
  for (const n of NAMES) assert.ok(text.includes(`defigent.job.${n}`), n);
});

test("jobsJsonSchema describes the input shapes", () => {
  const schema = jobsJsonSchema();
  const offer = schema.anyOf.find((s) => s.properties?.["defigent.job.offer"]).properties["defigent.job.offer"];
  assert.equal(offer.properties.offerId.pattern, "^of_[A-Za-z0-9]{10}$");
  assert.deepEqual(offer.properties.side.enum, ["client", "provider"]);
  assert.ok(offer.required.includes("expiresAt"));
});
