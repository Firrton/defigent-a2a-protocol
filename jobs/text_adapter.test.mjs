import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptTextReply } from "./text_adapter.mjs";

const OFFER_ID = "of_AbCdEf1234";
const A = "0xABC0000000000000000000000000000000000001"; // EIP-55 checksummed
const B = "0x0000000000000000000000000000000000000Bad";
const TX_HASH = "0x" + "ab".repeat(32);
const outOfferRow = { offerId: OFFER_ID, direction: "out", state: "open", peerAgentId: 10270 };
const findOffer = (row) => (id) => (id === OFFER_ID ? row : null);

test("an offerId plus one address is an accept with a checksummed address", () =>
  assert.deepEqual(adaptTextReply(`ok ${OFFER_ID} ${A.toLowerCase()}`, { findOffer: () => outOfferRow }),
    { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 10270 } } }));

test("the same address and offerId repeated still count as one", () =>
  assert.deepEqual(adaptTextReply(`${OFFER_ID}: pay ${A} (${A.toLowerCase()}) for ${OFFER_ID}`, { findOffer: findOffer(outOfferRow) }),
    { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 10270 } } }));

test("two addresses are ambiguous", () =>
  assert.equal(adaptTextReply(`${OFFER_ID} ${A} or ${B}`, { findOffer: findOffer(outOfferRow) }), null));

test("two distinct offerIds are ambiguous", () =>
  assert.equal(adaptTextReply(`${OFFER_ID} of_ZzZzZz9999 ${A}`, { findOffer: findOffer(outOfferRow) }), null));

test("a txHash is not an address and an embedded offerId is not an offerId", () => {
  assert.equal(adaptTextReply(`${OFFER_ID} paid in ${TX_HASH}`, { findOffer: findOffer(outOfferRow) }), null);
  assert.deepEqual(adaptTextReply(`${OFFER_ID} ${A} tx ${TX_HASH}`, { findOffer: findOffer(outOfferRow) }),
    { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 10270 } } });
  assert.equal(adaptTextReply(`xof_AbCdEf1234 ${A}`, { findOffer: () => outOfferRow }), null);
  assert.equal(adaptTextReply(`${OFFER_ID}x ${A}`, { findOffer: () => outOfferRow }), null);
});

test("NO_WALLET is a decline", () =>
  assert.deepEqual(adaptTextReply(`sorry, NO_WALLET for ${OFFER_ID}`, { findOffer: findOffer(outOfferRow) }),
    { name: "decline", body: { offerId: OFFER_ID, reason: "no_wallet" } }));

test("no address and no NO_WALLET is null", () =>
  assert.equal(adaptTextReply(`thinking about ${OFFER_ID}`, { findOffer: findOffer(outOfferRow) }), null));

test("unknown, inbound or no-longer-open offers are ignored", () => {
  const text = `${OFFER_ID} ${A}`;
  assert.equal(adaptTextReply(text, { findOffer: () => null }), null);
  assert.equal(adaptTextReply(text, { findOffer: findOffer({ ...outOfferRow, direction: "in" }) }), null);
  assert.equal(adaptTextReply(text, { findOffer: findOffer({ ...outOfferRow, state: "accepted" }) }), null);
  assert.equal(adaptTextReply(`NO_WALLET ${OFFER_ID}`, { findOffer: findOffer({ ...outOfferRow, state: "declined" }) }), null);
  assert.equal(adaptTextReply(`no offer here ${A}`, { findOffer: findOffer(outOfferRow) }), null);
});

test("the agentId comes from the text when the offer has none, and no agentId means null", () => {
  const noAgent = findOffer({ ...outOfferRow, peerAgentId: null });
  assert.deepEqual(adaptTextReply(`${OFFER_ID} ${A} agentId 777`, { findOffer: noAgent }),
    { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 777 } } });
  assert.deepEqual(adaptTextReply(`${OFFER_ID} ${A} AGENTID778`, { findOffer: noAgent }),
    { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 778 } } });
  assert.equal(adaptTextReply(`${OFFER_ID} ${A}`, { findOffer: noAgent }), null);
  assert.deepEqual(adaptTextReply(`${OFFER_ID} ${A} agentId 777`, { findOffer: findOffer(outOfferRow) }),
    { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 10270 } } });
});

test("non-string text is null", () =>
  assert.equal(adaptTextReply(undefined, { findOffer: findOffer(outOfferRow) }), null));
