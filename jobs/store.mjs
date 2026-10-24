// SQLite ledger for the typed jobs protocol: offers, reply dedupe, operator actions and outbox claims.
// Every `now` / timestamp is Unix seconds. JSON columns: terms, payload, result, body, deliverable, response.

const nowSeconds = () => Math.floor(Date.now() / 1000);
const toJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const fromJson = (s) => (s === null || s === undefined ? null : JSON.parse(s));

export function migrateJobsStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_offers (
  offer_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  peer_agent_id INTEGER,
  peer_address TEXT,
  peer_endpoint TEXT,
  context_id TEXT,
  terms_json TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','under_review','accepted','declined','expired')),
  expires_at INTEGER NOT NULL,
  accepted_address TEXT,
  accepted_agent_id INTEGER,
  job_id TEXT,
  chain_status TEXT,
  job_terminal INTEGER NOT NULL DEFAULT 0,
  deliverable_json TEXT,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_offers_job ON job_offers(job_id);
CREATE INDEX IF NOT EXISTS idx_job_offers_context ON job_offers(context_id);
CREATE INDEX IF NOT EXISTS idx_job_offers_agent_state ON job_offers(peer_agent_id, state);
CREATE TABLE IF NOT EXISTS job_seen (
  sender TEXT NOT NULL,
  message_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sender, message_id)
);
CREATE TABLE IF NOT EXISTS job_replies (
  natural_key TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_actions (
  action_key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  context_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed')),
  result_json TEXT,
  woken_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_actions_state ON job_actions(state, created_at);
CREATE INDEX IF NOT EXISTS idx_job_actions_action_ts ON job_actions(action, created_at);
CREATE TABLE IF NOT EXISTS job_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL,
  reply_id TEXT,
  name TEXT NOT NULL,
  body_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','rejected')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (context_id, reply_id)
);
CREATE INDEX IF NOT EXISTS idx_job_claims_state ON job_claims(state, id);`);
}

function offerFromRow(r) {
  if (!r) return null;
  return {
    offerId: r.offer_id,
    direction: r.direction,
    peerAgentId: r.peer_agent_id,
    peerAddress: r.peer_address,
    peerEndpoint: r.peer_endpoint,
    contextId: r.context_id,
    terms: fromJson(r.terms_json),
    termsHash: r.terms_hash,
    state: r.state,
    expiresAt: r.expires_at,
    acceptedAddress: r.accepted_address,
    acceptedAgentId: r.accepted_agent_id,
    jobId: r.job_id,
    chainStatus: r.chain_status,
    jobTerminal: r.job_terminal === 1,
    deliverable: fromJson(r.deliverable_json),
    checkedAt: r.checked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function actionFromRow(r) {
  if (!r) return null;
  return {
    key: r.action_key,
    action: r.action,
    payload: fromJson(r.payload_json),
    contextId: r.context_id,
    state: r.state,
    result: fromJson(r.result_json),
    wokenAt: r.woken_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function claimFromRow(r) {
  return {
    id: r.id,
    contextId: r.context_id,
    replyId: r.reply_id,
    name: r.name,
    body: fromJson(r.body_json),
    state: r.state,
    reason: r.reason,
  };
}

export function createJobsStore(db) {
  const q = (sql) => db.prepare(sql);
  const setOffer = (column) => q(`UPDATE job_offers SET ${column}=?, updated_at=? WHERE offer_id=?`);

  const stmt = {
    seenGet: q(`SELECT response_json FROM job_seen WHERE sender=? AND message_id=?`),
    seenPut: q(`INSERT INTO job_seen (sender, message_id, response_json, created_at) VALUES (?,?,?,?)
      ON CONFLICT(sender, message_id) DO UPDATE SET response_json=excluded.response_json`),
    replyGet: q(`SELECT body_hash, response_json FROM job_replies WHERE natural_key=?`),
    replyPut: q(`INSERT INTO job_replies (natural_key, body_hash, response_json, created_at) VALUES (?,?,?,?)
      ON CONFLICT(natural_key) DO UPDATE SET body_hash=excluded.body_hash, response_json=excluded.response_json`),

    offerInsert: q(`INSERT INTO job_offers (offer_id, direction, peer_agent_id, peer_address, peer_endpoint, context_id,
      terms_json, terms_hash, state, expires_at, accepted_address, accepted_agent_id, job_id, chain_status, job_terminal,
      deliverable_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    offerGet: q(`SELECT * FROM job_offers WHERE offer_id=?`),
    offerByJob: q(`SELECT * FROM job_offers WHERE job_id=? ORDER BY created_at LIMIT 1`),
    offerAccept: q(`UPDATE job_offers SET accepted_address=?, accepted_agent_id=?, context_id=?, state='accepted', updated_at=?
      WHERE offer_id=? AND state IN ('open','under_review') AND accepted_address IS NULL`),
    offerState: setOffer("state"),
    offerJob: setOffer("job_id"),
    offerChain: setOffer("chain_status"),
    offerTerminal: q(`UPDATE job_offers SET job_terminal=1, updated_at=? WHERE offer_id=?`),
    offerDeliverable: setOffer("deliverable_json"),
    offerChecked: q(`UPDATE job_offers SET checked_at=? WHERE offer_id=?`),
    offersOpenJobs: q(`SELECT * FROM job_offers WHERE job_id IS NOT NULL AND job_terminal=0
      ORDER BY checked_at IS NOT NULL, checked_at, created_at, rowid LIMIT ?`),
    offersOpenForAgent: q(`SELECT COUNT(*) AS n FROM job_offers WHERE peer_agent_id=? AND state IN ('open','under_review')`),

    // ON CONFLICT (not OR IGNORE) so only a duplicate key is a no-op; NOT NULL/CHECK violations still throw.
    actionInsert: q(`INSERT INTO job_actions (action_key, action, payload_json, context_id, state, created_at, updated_at)
      VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(action_key) DO NOTHING`),
    actionGet: q(`SELECT * FROM job_actions WHERE action_key=?`),
    actionsByState: q(`SELECT * FROM job_actions WHERE state=? ORDER BY created_at, rowid`),
    actionsUnwoken: q(`SELECT * FROM job_actions WHERE state='pending' AND woken_at IS NULL ORDER BY created_at, rowid LIMIT ?`),
    actionWoken: q(`UPDATE job_actions SET woken_at=?, updated_at=? WHERE action_key=?`),
    actionsSince: q(`SELECT COUNT(*) AS n FROM job_actions WHERE action=? AND created_at > ?`),
    actionFinish: q(`UPDATE job_actions SET state=?, result_json=?, updated_at=? WHERE action_key=?`),

    claimInsert: q(`INSERT INTO job_claims (context_id, reply_id, name, body_json, state, created_at, updated_at)
      VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(context_id, reply_id) DO NOTHING`),
    claimsPending: q(`SELECT * FROM job_claims WHERE state='pending' ORDER BY id LIMIT ?`),
    claimResolve: q(`UPDATE job_claims SET state=?, reason=?, updated_at=? WHERE id=?`),
  };

  return {
    transaction(fn) {
      return db.transaction(fn)();
    },

    seenResponse(sender, messageId) {
      return fromJson(stmt.seenGet.get(sender, messageId)?.response_json ?? null);
    },
    rememberResponse(sender, messageId, response, now = nowSeconds()) {
      stmt.seenPut.run(sender, messageId, JSON.stringify(response), now);
    },
    getReply(naturalKey) {
      const r = stmt.replyGet.get(naturalKey);
      return r ? { bodyHash: r.body_hash, response: fromJson(r.response_json) } : null;
    },
    saveReply(naturalKey, bodyHash, response, now = nowSeconds()) {
      stmt.replyPut.run(naturalKey, bodyHash, JSON.stringify(response), now);
    },

    insertOffer(row) {
      const created = row.createdAt ?? nowSeconds();
      stmt.offerInsert.run(
        row.offerId, row.direction, row.peerAgentId ?? null, row.peerAddress ?? null, row.peerEndpoint ?? null,
        row.contextId ?? null, JSON.stringify(row.terms), row.termsHash, row.state ?? "open", row.expiresAt,
        row.acceptedAddress ?? null, row.acceptedAgentId ?? null, row.jobId ?? null, row.chainStatus ?? null,
        row.jobTerminal ? 1 : 0, toJson(row.deliverable), created, row.updatedAt ?? created,
      );
    },
    getOffer(offerId) {
      return offerFromRow(stmt.offerGet.get(offerId));
    },
    findOfferByJobId(jobId) {
      return offerFromRow(stmt.offerByJob.get(String(jobId)));
    },
    acceptOffer(offerId, address, agentId, contextId, now) {
      return stmt.offerAccept.run(address, agentId, contextId, now, offerId).changes === 1;
    },
    setOfferState(offerId, state, now) {
      stmt.offerState.run(state, now, offerId);
    },
    linkJob(offerId, jobId, now) {
      stmt.offerJob.run(String(jobId), now, offerId);
    },
    setChainStatus(offerId, status, now) {
      stmt.offerChain.run(status, now, offerId);
    },
    markJobTerminal(offerId, now) {
      stmt.offerTerminal.run(now, offerId);
    },
    setDeliverable(offerId, deliverable, now) {
      stmt.offerDeliverable.run(toJson(deliverable), now, offerId);
    },
    // Sweep bookkeeping only (R23): it orders openJobOffers and does not bump updatedAt.
    markChecked(offerId, now) {
      stmt.offerChecked.run(now, offerId);
    },
    openJobOffers(limit) {
      return stmt.offersOpenJobs.all(limit).map(offerFromRow);
    },
    countOpenOffersForAgent(agentId) {
      return stmt.offersOpenForAgent.get(agentId).n;
    },

    enqueueAction({ key, action, payload, contextId, now }) {
      return stmt.actionInsert.run(key, action, JSON.stringify(payload ?? {}), contextId ?? null, now, now).changes === 1;
    },
    getAction(key) {
      return actionFromRow(stmt.actionGet.get(key));
    },
    listActions(state = "pending") {
      return stmt.actionsByState.all(state).map(actionFromRow);
    },
    unwokenActions(limit) {
      return stmt.actionsUnwoken.all(limit).map(actionFromRow);
    },
    markWoken(key, now) {
      stmt.actionWoken.run(now, now, key);
    },
    countActionsSince(action, sinceTs) {
      return stmt.actionsSince.get(action, sinceTs).n;
    },
    finishAction(key, state, result, now) {
      stmt.actionFinish.run(state, toJson(result), now, key);
    },

    recordClaim({ contextId, replyId, name, body, now }) {
      return stmt.claimInsert.run(contextId, replyId ?? null, name, JSON.stringify(body ?? {}), now, now).changes === 1;
    },
    pendingClaims(limit) {
      return stmt.claimsPending.all(limit).map(claimFromRow);
    },
    resolveClaim(id, state, reason, now) {
      stmt.claimResolve.run(state, reason ?? null, now, id);
    },
  };
}
