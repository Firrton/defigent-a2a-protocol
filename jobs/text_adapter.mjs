// Turns a plain-text reply to one of our open outbound offers into a typed accept or decline. Pure, no I/O.
import { getAddress } from "viem";

// Boundaries keep a 64-hex txHash, or an id glued to other characters, from matching.
const OFFER_ID_RE = /(?<![0-9A-Za-z])of_[A-Za-z0-9]{10}(?![0-9A-Za-z])/g;
const ADDRESS_RE = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
const AGENT_ID_RE = /agentId[ ]?(\d+)/i;
const NO_WALLET_RE = /(?<![0-9A-Za-z_])NO_WALLET(?![0-9A-Za-z_])/;

const distinct = (text, re, norm = (s) => s) => [...new Set((text.match(re) ?? []).map(norm))];

export function adaptTextReply(text, { findOffer }) {
  if (typeof text !== "string") return null;
  const offerIds = distinct(text, OFFER_ID_RE);
  if (offerIds.length !== 1) return null;
  const [offerId] = offerIds;
  const offer = findOffer(offerId);
  if (!offer || offer.direction !== "out" || offer.state !== "open") return null;

  const addresses = distinct(text, ADDRESS_RE, (a) => a.toLowerCase());
  if (addresses.length === 1) {
    const agentId = offer.peerAgentId ?? agentIdFromText(text);
    if (agentId == null) return null;
    return { name: "accept", body: { offerId, party: { address: getAddress(addresses[0]), agentId } } };
  }
  if (addresses.length === 0 && NO_WALLET_RE.test(text)) return { name: "decline", body: { offerId, reason: "no_wallet" } };
  return null;
}

function agentIdFromText(text) {
  const m = text.match(AGENT_ID_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
