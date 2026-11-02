# Protocolo de jobs tipado v1 (fase 1): plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Objetivo:** que el inbox resuelva con código, sin LLM, las ofertas y el ciclo de vida de los jobs ERC-8183 que llegan como DataParts tipados, y que el operador ejecute los pasos que mueven plata con un script en lugar de interpretar texto.

**Arquitectura:**
- La lógica nueva vive en módulos chicos dentro de `jobs/`, que se testean sin levantar el servidor: config, ABI, protocolo, store, lector de cadena, próximo paso, serialización, handlers puros, adaptador de texto, runtime y barrido.
- `http_server.mjs` solo los conecta:
  - un desvío tipado antes del dedupe en memoria;
  - un enganche en el outbox;
  - un intervalo para el barrido;
  - las rutas nuevas.
- Dos scripts cubren el lado del operador: `send_offer.mjs` y `jobs_actions.mjs`.

**Stack:** Node 22 (ESM `.mjs`), Express 5, better-sqlite3 13, viem 2.57, zod 4.6 y `node:test`.

**Spec:** `docs/jobs-protocol-v1-design.md`, aprobada el 2026-10-24.

## Decisiones que toma este plan (revisalas)

1. **Campo `from`.** Las ofertas pueden traer `from: { address, agentId }` como campo opcional. Nuestras ofertas salientes lo incluyen (agentId 10331). Si una oferta entrante no lo trae, el `accept` del operador aporta la identidad del provider.
2. **Dos códigos de error nuevos**, que se suman a la lista del diseño:
   - `unsupported_terms`: escrow ajeno, token no permitido o monto por encima del tope;
   - `capacity_exceeded`: se alcanzó un tope de cantidad, con `retryable: true`.
3. **Vencimiento del job.** El `expiredAt` del job es el `expiresAt` de la oferta. Un `accept` necesita que falte al menos 1 h (`minWorkWindowSeconds`); si no, recibe `offer_expired`.
4. **Claims que no se verifican.** Si un claim del outbox no pasa la verificación on-chain, se genera la acción `review_claim` para el operador.
5. **Líneas de wake.** Las de acciones las escribe solo el servidor. Las acciones que encola un script se despiertan en el barrido siguiente, guiándose por `woken_at`.
6. **Alcance de `status` y de las acciones.** Se responde `status` para cualquier job de nuestro escrow. Las acciones se generan solo si Defigent es el cliente, o el evaluador en el caso de `evaluate`.
7. **Hash del entregable.** Se lee del evento `JobSubmitted`, porque `getJob` no lo incluye.
8. **`next.actor`.** Usa los roles de ERC-8183 (`client`, `provider`, `evaluator`, `anyone`) más `ours: true|false`.
9. **Budget distinto del acordado.** No responde con un `error` `state_mismatch`, como decía el diseño. Responde con un `status` que trae `next.mismatch: true` y el `setBudget` correcto, para que el provider reciba la corrección lista para firmar. `state_mismatch` queda para los mensajes que no encajan con el estado de la oferta, por ejemplo un `decline` de una oferta ya aceptada.

## Restricciones globales

**Entorno**

- Todos los comandos corren con Node 22. Antes de cualquiera: `export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"`. El node por defecto es v20, y better-sqlite3 13 exige 22.
- No se agrega ninguna dependencia. viem, zod y better-sqlite3 se resuelven desde el `node_modules` del checkout padre. Nunca `npm` ni `npx`: si algo hace falta instalar, se frena y se consulta.
- Para leer y buscar se usan rg, fd, bat y eza, nunca grep, find, cat ni ls.

**Idioma y commits**

- Código, identificadores, comentarios, texto que viaja por el wire y la spec pública de la extensión van en inglés. Los docs de `docs/` van en español, salvo `docs/a2a-ext-erc8183-jobs-v1.md`.
- Commits convencionales en inglés, sin `Co-Authored-By` ni ninguna atribución a IA.

**Protocolo**

- URI de la extensión: exactamente `https://w3id.org/defigent/a2a/erc8183-jobs/v1`.
- Prefijo de las claves: `defigent.job.`. Los nombres son exactamente: `offer, accept, decline, created, budget_set, funded, submitted, completed, rejected, expired, query, status, error`.
- Formatos:
  - montos en unidades base como string decimal `^(0|[1-9][0-9]*)$`, como máximo 2^256−1;
  - direcciones con checksum EIP-55;
  - tiempos en segundos Unix;
  - chainId 143;
  - `offerId` con la forma `^of_[A-Za-z0-9]{10}$`;
  - `jobId` como string decimal de un uint256 mayor o igual a 1.

**Seguridad y escrow**

- El inbox nunca firma transacciones ni hace requests a URLs que llegan en mensajes.
- `complete()` se manda con `max(estimación × 1.3, 700000)` de gas.
- `EVALUATION_GRACE_PERIOD` es 3600 s y `minOfferTtlSeconds` es 86400.

**Compatibilidad e integración**

- El camino de texto no cambia: los tests existentes de `a2a_inbox.test.mjs` tienen que seguir pasando sin tocarlos.
- Antes del PR: `git fetch origin && git rebase origin/main`. Si `fix/claims-and-classifier-quick-wins` entró antes, se resuelven los conflictos conservando los dos comportamientos.

## Foco de revisión

1. **DataPart tipado con texto de clase máquina.** Si el mensaje trae un DataPart tipado y un texto con una frase de clase máquina (`sha256 hash of "x"`, un aviso de Taifoon), va por el camino tipado y la clase digest no cierra la tarea. Lo cubre la Tarea 10.
2. **`accept` repetido tras un reinicio.** El mismo `accept` reenviado después de reiniciar el servidor recibe la misma respuesta y genera un solo `create_job`. Lo cubre la Tarea 8.
3. **RPC que se cuelga.** El pedido tipado responde `-32603 CHAIN_UNAVAILABLE` dentro de `rpcTimeoutMs` y no persiste nada. Lo cubren las Tareas 4 y 8.
4. **Montos y direcciones raros** (`"0250000"`, `"2.5"`, `"-1"`, 2^256, una dirección en minúsculas). Los montos mal formados se rechazan y las direcciones se normalizan a checksum. Lo cubre la Tarea 2.
5. **Jobs que no deben generar acciones.** Un job Submitted que alguien ya reembolsó (Expired), o un job Funded con un claim pendiente: el barrido no genera ni `evaluate` ni `refund`. Lo cubre la Tarea 9.

## Antes de empezar

- [ ] `node -v` devuelve `v22.x`.
- [ ] `node --input-type=module -e 'await import("viem"); await import("zod"); await import("better-sqlite3"); console.log("ok")'` devuelve `ok`. Si falla, frenar y reportar sin instalar nada.
- [ ] `git add docs/jobs-protocol-v1-design.md docs/jobs-protocol-v1-plan.md && git commit -m "docs: add typed jobs protocol v1 design and plan"`

---

### Task 1: Config y ABI

**Archivos:**
- Crear: `data/jobs-config.json`, `jobs/config.mjs`, `jobs/abi.mjs`
- Test: `jobs/config.test.mjs`, `jobs/abi.test.mjs`
- Modificar: `package.json` (script `test`)

**Interfaces:**
- Produce:
  - `loadJobsConfig({ file?: string|URL, env?: Record<string,string> } = {}) → JobsConfig`
  - `JobsConfig = { chainId: 143, agentId: 10331, escrow, identityRegistry, client, evaluator, hook: Address, tokens: Record<string, { address: Address, decimals: number }>, caps: { maxOfferAmount: bigint, maxOpenOffersPerAgent: number, maxCreateJobPerDay: number }, minOfferTtlSeconds, minWorkWindowSeconds, rpcTimeoutMs, sweepMs: number, inboxUrl, schemaUrl: string }`
  - `tokenByAddress(config, address) → { symbol, address, decimals } | null` y `tokenBySymbol(config, symbol)`, con la misma forma
  - `ESCROW_ABI`, `IDENTITY_ABI`, `ERC20_ABI` (con `parseAbi` de viem), `JOB_STATUS = ["Open","Funded","Submitted","Completed","Rejected","Expired"]`, `EVALUATION_GRACE_SECONDS = 3600`

Valores de `data/jobs-config.json`. El hook es el v1 hasta que se deploye el PR #5; después se cambia acá o con `DEFIGENT_JOBS_HOOK`.

```json
{
  "chainId": 143, "agentId": 10331,
  "escrow": "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65",
  "identityRegistry": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "client": "0x940ecB27d8f4F7009c8BC12969496E9639717638",
  "evaluator": "0x940ecB27d8f4F7009c8BC12969496E9639717638",
  "hook": "0x03d516e52fd64e2d19a817498f941d7dea452cd6",
  "tokens": { "USDC": { "address": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "decimals": 6 } },
  "caps": { "maxOfferAmount": "1000000", "maxOpenOffersPerAgent": 2, "maxCreateJobPerDay": 10 },
  "minOfferTtlSeconds": 86400, "minWorkWindowSeconds": 3600,
  "rpcTimeoutMs": 3000, "sweepMs": 60000,
  "inboxUrl": "https://opacus-liana-lanceted.ngrok-free.dev/inbox",
  "schemaUrl": "https://opacus-liana-lanceted.ngrok-free.dev/schemas/erc8183-jobs-v1.json"
}
```

- [ ] **Paso 1: Escribir los tests que fallan**

```js
// jobs/config.test.mjs
test("loads data/jobs-config.json with checksummed addresses and bigint caps", () => {
  const c = loadJobsConfig({ env: {} });
  assert.equal(c.escrow, "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65");
  assert.equal(c.hook, getAddress("0x03d516e52fd64e2d19a817498f941d7dea452cd6"));
  assert.equal(c.caps.maxOfferAmount, 1000000n);
  assert.equal(c.sweepMs, 60000);
});
test("env overrides sweep interval, rpc timeout and hook", () => {
  const c = loadJobsConfig({ env: { DEFIGENT_JOBS_SWEEP_MS: "200", DEFIGENT_JOBS_RPC_TIMEOUT_MS: "500", DEFIGENT_JOBS_HOOK: "0x000000000000000000000000000000000000dead" } });
  assert.deepEqual([c.sweepMs, c.rpcTimeoutMs, c.hook], [200, 500, "0x000000000000000000000000000000000000dEaD"]);
});
test("a sweep interval under 50 ms is rejected", () =>
  assert.throws(() => loadJobsConfig({ env: { DEFIGENT_JOBS_SWEEP_MS: "10" } }), /DEFIGENT_JOBS_SWEEP_MS/));
test("a malformed escrow address names the field", () =>
  assert.throws(() => loadJobsConfig({ file: tmpConfig({ escrow: "0x123" }), env: {} }), /escrow/));
test("tokenByAddress ignores case", () =>
  assert.equal(tokenByAddress(loadJobsConfig({ env: {} }), "0x754704bc059f8c67012fed69bc8a327a5aafb603").symbol, "USDC"));

// jobs/abi.test.mjs
test("getJob outputs follow the ERC8183 Job struct order", () => {
  const out = ESCROW_ABI.find((f) => f.name === "getJob").outputs[0].components.map((c) => `${c.type} ${c.name}`);
  assert.deepEqual(out, ["address client", "uint8 status", "address provider", "uint48 expiredAt", "address evaluator", "uint48 submittedAt",
    "uint256 budget", "address hook", "address paymentToken", "uint256 providerAgentId", "string description", "uint256 settledAmount", "address payoutReceiver"]);
});
test("write selectors match the contract signatures", () => {
  for (const sig of ["createJob(address,address,uint48,string,address,uint256)", "setBudget(uint256,address,uint256,bytes)", "fund(uint256,address,uint256,bytes)",
    "submit(uint256,bytes32,bytes)", "complete(uint256,bytes32,bytes)", "reject(uint256,bytes32,bytes)", "claimRefund(uint256)"])
    assert.ok(ESCROW_ABI.some((f) => f.type === "function" && toFunctionSelector(f) === toFunctionSelector(sig)), sig);
});
```

- [ ] **Paso 2:** `node --test jobs/config.test.mjs jobs/abi.test.mjs`. Esperado: FAIL (`Cannot find module`).
- [ ] **Paso 3: Implementar `loadJobsConfig` en `jobs/config.mjs` y los ABIs en `jobs/abi.mjs`**
  - **`loadJobsConfig`:** lee el JSON y aplica estas variables de entorno: `DEFIGENT_JOBS_SWEEP_MS` (mínimo 50), `DEFIGENT_JOBS_RPC_TIMEOUT_MS` (mínimo 100) y `DEFIGENT_JOBS_HOOK`. Normaliza las direcciones con `getAddress` y, ante un valor inválido, lanza `Error("jobs-config: <campo> …")`.
  - **`ESCROW_ABI`** se arma con `parseAbi`. Incluye:
    - `struct Job {…}`, en el orden del test;
    - las seis escrituras del test;
    - las vistas `getJob`, `jobCounter`, `allowedPaymentTokens`, `pendingClaimHash` y `whitelistedHooks`;
    - los eventos `JobCreated` y `JobSubmitted`, con las firmas de `ERC8183.sol:106` y `:145`.
  - **`IDENTITY_ABI`** trae `ownerOf` y `getAgentWallet`, y **`ERC20_ABI`** trae `approve` y `decimals`.
  - **`package.json`:** el script `test` pasa a ser `node --test network_directory.test.mjs jobs/*.test.mjs`.
- [ ] **Paso 4:** el mismo comando del paso 2. Esperado: PASS.
- [ ] **Paso 5:** `git add data/jobs-config.json jobs/config.mjs jobs/abi.mjs jobs/config.test.mjs jobs/abi.test.mjs package.json && git commit -m "feat(jobs): add jobs config and ERC-8183 ABI"`

---

### Task 2: Protocolo (esquemas, detección, legacy, JSON canónico)

**Archivos:**
- Crear: `jobs/protocol.mjs`
- Test: `jobs/protocol.test.mjs`

**Interfaces:**
- Consume: `JobsConfig`, `tokenBySymbol` y `tokenByAddress` (Tarea 1).
- Produce:
  - `EXT_URI`, `KEY_PREFIX = "defigent.job."`, `NAMES` (los 13 nombres), `NOTICE_NAMES` (los 7 avisos) y `fullKey(name) → string`
  - `detectTyped(dataParts: unknown[]) → { kind: "none" } | { kind: "typed", name, body } | { kind: "legacy", body } | { kind: "invalid", field, detail }`
  - `parseTyped(name, body) → { ok: true, value } | { ok: false, field, detail } | { ok: false, unsupported: true }`
  - `normalizeLegacyOffer(body, config, { newId = newOfferId } = {})`, que devuelve lo mismo que `parseTyped`
  - `newOfferId() → string`
  - `canonicalJson(value) → string`
  - `termsHash(offer) → Hex`
  - `jobDescription(offer) → string`
  - `parseJobDescription(text) → { v: 1, offerId, terms } | null`
  - `jobsJsonSchema() → object`

Reglas de los esquemas (zod descarta los campos desconocidos):

- **`offer`:**
  - `offerId`;
  - `side: "client"|"provider"`;
  - `service` con la forma `^[a-z0-9][a-z0-9-]{0,63}$`;
  - `description` de 1 a 2000 caracteres;
  - `price { amount, token, decimals 0..18, symbol ≤16 }`;
  - `settlement { chainId: 143, escrow }`;
  - `deliverable { mediaType ≤100, acceptance: "operator"|"hash", expectedHash? }`.

  Son opcionales `providerSteps`, `gas { providerTxs, grant: Amount|null }`, `from { address, agentId }`, `to { agentId }` y `replyTo { url, contextId }`. Lleva `expiresAt`.
- **`accept`:** `{ offerId, party: { address, agentId } }`.
- **`decline`:** `{ offerId, reason: "price"|"scope"|"expired"|"capacity"|"no_wallet"|"other", note? ≤500 }`.
- **Avisos:** `{ jobId, txHash? }`. `submitted` suma `deliverable { hash, uri? ≤2048, mediaType? }`.
- **`query`:** exactamente uno de `offerId` o `jobId`.
- **`status` y `error`:** validación laxa, porque solo se registran.

- [ ] **Paso 1: Escribir los tests que fallan.** Los helpers `validOffer` y `offerWith(overrides)` del test arman una oferta válida.

```js
test("detects exactly one defigent.job.* key and ignores arrays and plain parts", () => {
  assert.deepEqual(detectTyped([{ a: 1 }, ["x"]]), { kind: "none" });
  assert.equal(detectTyped([{ "defigent.job.query": { jobId: "42" } }]).name, "query");
  assert.equal(detectTyped([{ "defigent.job.query": {}, "defigent.job.accept": {} }]).kind, "invalid");
  assert.equal(detectTyped([{ "defigent.job.query": {} }, { "defigent.job.accept": {} }]).kind, "invalid");
  assert.deepEqual(detectTyped([{ "defigent.job.teleport": {} }]), { kind: "typed", name: "teleport", body: {} });
  assert.equal(detectTyped([{ intent: "offer", service: "s", price: "1.00" }]).kind, "legacy");
});
test("unknown names are unsupported, not invalid", () =>
  assert.deepEqual(parseTyped("teleport", {}), { ok: false, unsupported: true }));
test("rejects malformed amounts and normalizes addresses", () => {
  for (const amount of ["0250000", "2.5", "-1", (2n ** 256n).toString(), ""])
    assert.equal(parseTyped("offer", offerWith({ price: { amount } })).ok, false, amount);
  assert.equal(parseTyped("offer", offerWith({ price: { token: USDC.toLowerCase() } })).value.price.token, USDC);
});
test("validation errors name the field path", () =>
  assert.equal(parseTyped("accept", { offerId: "of_short", party: { address: A, agentId: 1 } }).field, "offerId"));
test("query needs exactly one of offerId or jobId", () => {
  assert.equal(parseTyped("query", {}).ok, false);
  assert.equal(parseTyped("query", { offerId: OFFER_ID, jobId: "42" }).ok, false);
});
test("legacy offer_schema_v1 becomes a provider-side offer in base units and seconds", () => {
  const r = normalizeLegacyOffer({ intent: "offer", service: "lint", price: "1.25", asset: "USDC", expiry: 1792800000000, terms: "lint your card" }, cfg, { newId: () => "of_AAAAAAAAAA" });
  assert.deepEqual([r.value.side, r.value.price.amount, r.value.expiresAt, r.value.description], ["provider", "1250000", 1792800000, "lint your card"]);
});
test("a legacy offer with an unknown asset is invalid", () =>
  assert.equal(normalizeLegacyOffer({ intent: "offer", service: "x", price: "1", asset: "DOGE" }, cfg).field, "asset"));
test("canonicalJson sorts keys recursively and termsHash ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3] } }), '{"a":{"c":[3],"d":2},"b":1}');
  assert.equal(termsHash({ a: 1, b: 2 }), termsHash({ b: 2, a: 1 }));
});
test("jobDescription round-trips and plain descriptions are not ours", () => {
  assert.deepEqual(parseJobDescription(jobDescription(validOffer)), { v: 1, offerId: validOffer.offerId, terms: termsHash(validOffer) });
  assert.equal(parseJobDescription("dogfood job"), null);
});
test("jobsJsonSchema covers the 13 keys", () => {
  const text = JSON.stringify(jobsJsonSchema());
  for (const n of NAMES) assert.ok(text.includes(`defigent.job.${n}`), n);
});
```

- [ ] **Paso 2:** `node --test jobs/protocol.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3: Implementar `jobs/protocol.mjs`.**
  - Un objeto zod por nombre. `detectTyped` solo mira objetos planos (nunca arrays) y cuenta las claves con el prefijo en todas las partes.
  - `parseTyped` convierte el primer issue de zod en `{ field: path.join("."), detail: message }`.
  - **Tipos base:**
    - `Amount` es la regex más `BigInt(x) <= 2n**256n - 1n`;
    - `Address` es `^0x[0-9a-fA-F]{40}$`, transformada con `getAddress`.
  - **Ids y hashes:**
    - `newOfferId` usa `crypto.randomBytes` sobre el alfabeto base62;
    - `canonicalJson` lanza un error si encuentra un `bigint` o un `undefined`;
    - `termsHash` es `keccak256(toBytes(canonicalJson(offer)))`;
    - `jobDescription` es `canonicalJson({ v: 1, offerId, terms: termsHash(offer) })`.
  - `jobsJsonSchema` aplica `z.toJSONSchema` sobre la unión de los objetos `{ [fullKey(name)]: schema }`.
- [ ] **Paso 4:** el mismo comando. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/protocol.mjs jobs/protocol.test.mjs && git commit -m "feat(jobs): add typed message schemas and detection"`

---

### Task 3: Store (el ledger en SQLite)

**Archivos:**
- Crear: `jobs/store.mjs`
- Test: `jobs/store.test.mjs`

**Interfaces:**
- **Produce:** `migrateJobsStore(db)` y `createJobsStore(db) → JobsStore`.
- **Tablas:** los nombres están fijos y las columnas las elige quien construye.

  | Tabla | Clave |
  |---|---|
  | `job_offers` | PK `offer_id` |
  | `job_seen` | PK (`sender`, `message_id`) |
  | `job_replies` | PK `natural_key` |
  | `job_actions` | PK `action_key` |
  | `job_claims` | PK autoincremental, UNIQUE(`context_id`, `reply_id`) |

- **Filas:**
  - `OfferRow = { offerId, direction: "out"|"in", peerAgentId, peerAddress, peerEndpoint, contextId, terms: object, termsHash, state: "open"|"under_review"|"accepted"|"declined"|"expired", expiresAt, acceptedAddress, acceptedAgentId, jobId: string|null, chainStatus, jobTerminal: boolean, deliverable: object|null, createdAt, updatedAt }`
  - `ActionRow = { key, action, payload, contextId, state: "pending"|"done"|"failed", result, wokenAt, createdAt, updatedAt }`
  - `ClaimRow = { id, contextId, replyId, name, body, state: "pending"|"verified"|"rejected", reason }`
- **Métodos de `JobsStore`:**
  - **General:** `transaction(fn)`.
  - **Dedupe e idempotencia:**
    - `seenResponse(sender, messageId) → object|null`
    - `rememberResponse(sender, messageId, response)`
    - `getReply(naturalKey) → { bodyHash, response }|null`
    - `saveReply(naturalKey, bodyHash, response)`
  - **Ofertas:**
    - `insertOffer(row)`
    - `getOffer(offerId)`
    - `findOfferByJobId(jobId)`
    - `acceptOffer(offerId, address, agentId, now) → boolean`
    - `setOfferState(offerId, state, now)`
    - `linkJob(offerId, jobId, now)`
    - `setChainStatus(offerId, status, now)`
    - `markJobTerminal(offerId, now)`
    - `setDeliverable(offerId, deliverable, now)`
    - `openJobOffers(limit)`
    - `countOpenOffersForAgent(agentId)`
  - **Acciones:**
    - `enqueueAction({ key, action, payload, contextId, now }) → boolean`
    - `getAction(key)`
    - `listActions(state = "pending")`
    - `unwokenActions(limit)`
    - `markWoken(key, now)`
    - `countActionsSince(action, sinceTs)`
    - `finishAction(key, state, result, now)`
  - **Claims:**
    - `recordClaim({ contextId, replyId, name, body, now }) → boolean`
    - `pendingClaims(limit)`
    - `resolveClaim(id, state, reason, now)`

- [ ] **Paso 1: Escribir los tests que fallan**, con `new Database(":memory:")`.

```js
const fresh = () => { const db = new Database(":memory:"); migrateJobsStore(db); return createJobsStore(db); };
test("migration is idempotent", () => { const db = new Database(":memory:"); migrateJobsStore(db); migrateJobsStore(db); });
test("only the first accept wins", () => {
  const s = fresh(); s.insertOffer(outOfferRow);
  assert.equal(s.acceptOffer(OFFER_ID, A, 10270, 1), true);
  assert.equal(s.acceptOffer(OFFER_ID, B, 10271, 2), false);
  assert.equal(s.getOffer(OFFER_ID).acceptedAddress, A);
});
test("enqueueAction dedupes by key and unwoken actions are listed until woken", () => {
  const s = fresh();
  assert.equal(s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c", now: 1 }), true);
  assert.equal(s.enqueueAction({ key: "fund:42", action: "fund", payload: {}, contextId: "c", now: 2 }), false);
  assert.equal(s.unwokenActions(10).length, 1); s.markWoken("fund:42", 3); assert.equal(s.unwokenActions(10).length, 0);
});
test("rememberResponse is keyed by sender and messageId", ...);
test("recordClaim dedupes by contextId + replyId", ...);
test("openJobOffers skips terminal jobs and offers without a job", ...);
test("countActionsSince counts only that action after the timestamp", ...);
```

- [ ] **Paso 2:** `node --test jobs/store.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3: Implementar `jobs/store.mjs`** con `CREATE TABLE IF NOT EXISTS`, el mismo estilo que `http_server.mjs:160-185`. `terms`, `payload`, `result`, `body` y `deliverable` se guardan como JSON.
- [ ] **Paso 4:** el mismo comando. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/store.mjs jobs/store.test.mjs && git commit -m "feat(jobs): add SQLite ledger for offers, actions and claims"`

---

### Task 4: Lector de cadena, fake de tests y próximo paso

**Archivos:**
- Crear: `jobs/chain.mjs`, `jobs/fake_chain.mjs`, `jobs/next.mjs`
- Test: `jobs/chain.test.mjs`, `jobs/next.test.mjs`

**Interfaces:**
- Consume: `ESCROW_ABI`, `IDENTITY_ABI`, `JOB_STATUS` y `EVALUATION_GRACE_SECONDS` (Tarea 1).
- Produce:
  - `class ChainUnavailable extends Error`
  - `createChainReader({ config, rpcUrl, timeoutMs = config.rpcTimeoutMs, transport? }) → ChainReader`
  - `ChainReader = { getJob(jobId: bigint) → Job|null, isAllowedToken(addr) → boolean, isBoundToAgent(addr, agentId: bigint) → boolean, hasPendingClaim(jobId) → boolean, submittedDeliverable(jobId) → Hex|null, blockTime() → number, simulate({ account, to, data, value? }) → { ok: true } | { ok: false, reason } }`. Todos los métodos son async.
  - `Job = { jobId: bigint, client, status: "Open"|…|"Expired", provider, expiredAt: number, evaluator, submittedAt: number, budget: bigint, hook, paymentToken, providerAgentId: bigint, description, settledAmount: bigint, payoutReceiver }`
  - `createFakeChain({ jobs = {}, bindings = [], allowedTokens = [], now = 1792000000, pendingClaims = [], deliverables = {}, simulate, fail = false, hang = false, timeoutMs = 50 }) → ChainReader`, que además expone `calls: number`
  - `nextStep({ job, offer, now, config, pendingClaim = false }) → Next`
  - `offerNext(offer, now) → Next`
  - `taskStateFor({ next, job, offer }) → "working"|"input-required"|"completed"|"failed"`
  - `Next = { actor: "client"|"provider"|"evaluator"|"anyone"|null, ours: boolean, action?: "create_job"|"fund"|"evaluate"|"refund", call?: { to, function, args, data? }, deadline?, urgent?, mismatch?, note }`

**Reglas de `nextStep`.** El monto y el token acordados salen de `offer.terms.price`. Si no hay oferta, `call` va sin `data`.

| Estado | Resultado |
|---|---|
| Open y `now ≥ expiredAt` | `actor: null`, sin acción (no hay fondos) |
| Open con budget 0 | provider: `setBudget(jobId, token, monto, "0x")`, con `data` |
| Open con budget o token distinto del acordado | lo mismo, más `mismatch: true` |
| Open con budget igual al acordado | client, acción `fund` |
| Funded, vencido y sin claim pendiente | anyone, acción `refund` |
| Funded, vencido y con claim pendiente | `actor: null`, sin acción |
| Funded | provider: `submit(jobId, <hash del entregable>, "0x")`, sin `data` |
| Submitted | evaluator, acción `evaluate`, `deadline = expiredAt + 3600`, `urgent = now ≥ deadline − 21600` (vale aunque ya pasó el límite) |
| Completed, Rejected o Expired | `actor: null` |

En todos los casos, `ours` es verdadero solo si el rol es nuestro: `job.client == config.client`, o `job.evaluator == config.evaluator` para `evaluate`.

**Reglas de `taskStateFor`:** Completed da `completed`; Rejected y Expired dan `failed`; `ours` da `working`; el resto da `input-required`.

**Reglas de `offerNext`:**
- Oferta saliente abierta: la contraparte tiene que responder.
- Oferta entrante en revisión: nos toca a nosotros.
- Aceptada y sin job: client, acción `create_job`.
- Declinada o vencida: `actor: null`.

- [ ] **Paso 1: Escribir los tests que fallan.** El lector se prueba con el transporte `custom` de viem.

```js
// jobs/chain.test.mjs
test("getJob maps the struct and returns null for an empty slot", ...);
test("isBoundToAgent: owner match, wallet match, neither, and ownerOf revert", ...);
test("a hanging transport raises ChainUnavailable within the timeout", async () => {
  const r = createChainReader({ config: cfg, rpcUrl: "http://unused", timeoutMs: 200, transport: custom({ request: () => new Promise(() => {}) }) });
  const t0 = Date.now();
  await assert.rejects(r.getJob(1n), ChainUnavailable);
  assert.ok(Date.now() - t0 < 1000);
});
test("a transport error raises ChainUnavailable", ...);
test("simulate returns the revert reason", ...);

// jobs/next.test.mjs
test("Open without budget: the provider calls setBudget with the agreed amount", () => {
  const n = nextStep({ job: job({ status: "Open", budget: 0n }), offer, now: T, config: cfg });
  assert.equal(n.actor, "provider");
  assert.deepEqual(n.call.args, ["42", USDC, "250000", "0x"]);
  assert.equal(n.call.data, encodeFunctionData({ abi: ESCROW_ABI, functionName: "setBudget", args: [42n, USDC, 250000n, "0x"] }));
});
test("Open with a different budget flags a mismatch", ...);
test("Open with the agreed budget: we fund", () =>
  assert.deepEqual(pick(nextStep({ job: job({ status: "Open", budget: 250000n, paymentToken: USDC }), offer, now: T, config: cfg })), { actor: "client", ours: true, action: "fund" }));
test("Funded: the provider submits", ...);
test("Submitted: evaluate before expiredAt + 3600, urgent in the last 6 h", ...);
test("Funded past expiry with a pending claim: no refund", ...);
test("Funded past expiry without a pending claim: refund", ...);
test("terminal states have no actor and map to completed or failed", ...);
test("offerNext covers open, under_review, accepted and declined", ...);
test("jobs whose client is not us never get ours: true", ...);
```

- [ ] **Paso 2:** `node --test jobs/chain.test.mjs jobs/next.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3: Implementar los tres módulos.**
  - **Cliente.** El lector usa `createPublicClient` con `defineChain` para el chainId 143, igual que `scripts/dogfood_e2e.mjs:9-14`, y `http(rpcUrl, { retryCount: 0 })` o el `transport` que reciba.
  - **Errores y timeout.** Cada llamada pasa por su propio timeout (`Promise.race`), que lanza `ChainUnavailable`. Un revert de `ownerOf` o `getAgentWallet` no se trata como error: devuelve `false`.
  - **Métodos puntuales:**
    - `submittedDeliverable` lee los logs `JobSubmitted` filtrados por `jobId`;
    - `blockTime` usa el `timestamp` de `getBlock()`.
  - **El fake** con `hang` rechaza con `ChainUnavailable` cuando pasa `timeoutMs`, y con `fail` rechaza enseguida.
- [ ] **Paso 4:** el mismo comando. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/chain.mjs jobs/fake_chain.mjs jobs/next.mjs jobs/chain.test.mjs jobs/next.test.mjs && git commit -m "feat(jobs): add chain reader and next-step rules"`

---

### Task 5: Formato de wire según la versión de A2A

**Archivos:**
- Crear: `jobs/wire.mjs`
- Test: `jobs/wire.test.mjs`

**Interfaces:**
- Consume: `EXT_URI` y `fullKey` (Tarea 2).
- Produce:
  - `negotiateVersion(header: string) → "0.3"|"1.0"`. Un header vacío o que empieza con `0.3` da `"0.3"`; uno que empieza con `1.0` da `"1.0"`.
  - `typedResult({ version, contextId, state, name, body, text, messageId }) → object`, que es el `result` de JSON-RPC.
  - `invalidParams({ id, field, detail }) → object` y `chainUnavailable({ id }) → object`, que son respuestas JSON-RPC completas.
  - `extensionsEcho(headers) → { name, value } | null`
  - `sseFrame(rpcResponse) → string`

**Formas de la respuesta.** Si `name` es `null`, el mensaje lleva solo la parte de texto.
- **1.0:** `{ task: { id, contextId, status: { state: "TASK_STATE_<MAYÚSCULAS>", timestamp, message: { messageId, contextId, taskId, role: "ROLE_AGENT", extensions: [EXT_URI], parts: [ { data: { [fullKey(name)]: body }, mediaType: "application/json" }, { text } ] } } } }`
- **0.3:** `{ kind: "task", id, contextId, status: { state: "<minúsculas>", timestamp, message: { kind: "message", messageId, contextId, taskId, role: "agent", extensions: [EXT_URI], parts: [ { kind: "data", data: {…} }, { kind: "text", text } ] } } }`

**Errores:**
- **`invalidParams`:** código `-32602`, mensaje `"Invalid params"` y un `data` con dos objetos:
  - `{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field, description }] }`;
  - `{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INVALID_TYPED_MESSAGE", domain: EXT_URI, metadata: { field } }`.
- **`chainUnavailable`:** código `-32603`, mensaje `"Chain unavailable"` y `data` con un `ErrorInfo` de `reason: "CHAIN_UNAVAILABLE"` y `metadata: { retryable: "true" }`.

**Otras reglas:**
- `extensionsEcho` devuelve `{ name: "A2A-Extensions" }` o `{ name: "X-A2A-Extensions" }` cuando ese header lista `EXT_URI` (separado por comas), con `value: EXT_URI`.
- `sseFrame(r)` devuelve `"data: " + JSON.stringify(r) + "\n\n"`.

- [ ] **Paso 1: Escribir los tests que fallan**

```js
test("1.0 result wraps a task with TASK_STATE_* and ROLE_AGENT and no kind fields", () => {
  const r = typedResult({ version: "1.0", contextId: "c1", state: "input-required", name: "status", body: { next: null }, text: "t", messageId: "m" });
  assert.equal(r.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  assert.equal(r.task.status.message.role, "ROLE_AGENT");
  assert.deepEqual(r.task.status.message.parts[0], { data: { "defigent.job.status": { next: null } }, mediaType: "application/json" });
  assert.ok(!JSON.stringify(r).includes('"kind"'));
});
test("0.3 result is the task itself with kind fields and lowercase state", ...);
test("logged-only replies carry just the text part", ...);
test("invalidParams carries BadRequest and ErrorInfo with the extension domain", ...);
test("chainUnavailable is -32603 with CHAIN_UNAVAILABLE", ...);
test("extensionsEcho answers on either header name only when the URI is listed", ...);
test("sseFrame is one data line ended by a blank line", ...);
```

- [ ] **Paso 2:** `node --test jobs/wire.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3:** implementar según las formas de arriba. El mapeo de estados es `working`→`WORKING`, `input-required`→`INPUT_REQUIRED`, `completed`→`COMPLETED`, `rejected`→`REJECTED` y `failed`→`FAILED`.
- [ ] **Paso 4:** el mismo comando. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/wire.mjs jobs/wire.test.mjs && git commit -m "feat(jobs): add A2A 0.3 and 1.0 serializers for typed replies"`

---

### Task 6: Handlers puros

**Archivos:**
- Crear: `jobs/handlers.mjs`
- Test: `jobs/handlers.test.mjs`

**Interfaces:**
- Consume: `nextStep`, `offerNext` y `taskStateFor` (Tarea 4), y `jobDescription` (Tarea 2).
- Produce:
  - `handleOffer({ msg, now, config, counts: { openOffersForAgent } }) → Outcome`
  - `handleAccept({ msg, offer, bound: boolean, now, config, counts: { createJobsToday } }) → Outcome`
  - `handleDecline({ msg, offer, now }) → Outcome`
  - `handleJobMessage({ name, msg, offer, job, now, config, pendingClaim, deliverable }) → Outcome`
  - `statusBody({ offer, job, next }) → object`, con la forma `{ offer?: { offerId, state }, job?: { jobId, chainStatus, client, provider, evaluator, budget: { amount, token }, expiresAt, submittedAt, deliverable }, next }`
  - `Outcome = { reply: { name: "status"|"error", body }, text, taskState, actions: Array<{ key, action, payload }>, ops: Array<Op> }`
  - `Op` es una de estas formas:
    - `{ op: "insertOffer", row }`
    - `{ op: "accept", offerId, address, agentId }`
    - `{ op: "setOfferState", offerId, state }`
    - `{ op: "setDeliverable", offerId, deliverable }`
    - `{ op: "setChainStatus", offerId, status }`
  - El cuerpo de `error` es `{ code, message, field?, retryable }`. Todo `error` de negocio deja `taskState: "rejected"`.

**Claves de las acciones y sus payloads:**

| Clave | Payload |
|---|---|
| `review_offer:<offerId>` | `{ offerId, side, service, price, from }` |
| `create_job:<offerId>` | `{ offerId, provider, agentId, evaluator, hook, expiredAt, description, token, amount }` |
| `gas_grant:<offerId>` | `{ to, amountWei }`, solo si la oferta tiene `gas.grant` |
| `fund:<jobId>` | `{ jobId, token, amount }` |
| `evaluate:<jobId>` | `{ jobId, deadline, urgent, deliverable }` |
| `refund:<jobId>` | `{ jobId }` |

- [ ] **Paso 1: Escribir los tests que fallan.** Cubren una fila de la tabla de reglas del diseño por test.

```js
test("an inbound offer goes to review", () => {
  const o = handleOffer({ msg: inboundOffer, now: T, config: cfg, counts: { openOffersForAgent: 0 } });
  assert.equal(o.reply.body.offer.state, "under_review"); assert.equal(o.taskState, "working");
  assert.deepEqual(o.actions.map((a) => a.key), [`review_offer:${inboundOffer.offerId}`]);
});
test("a foreign escrow, a disallowed token or an amount over the cap gets unsupported_terms", ...);
test("an expired offer gets offer_expired; too many open offers gets capacity_exceeded", ...);
test("accepting our open offer by the bound agent enqueues create_job with the canonical description", () => {
  const o = handleAccept({ msg: accept, offer: outOffer, bound: true, now: T, config: cfg, counts: { createJobsToday: 0 } });
  assert.equal(o.reply.body.offer.state, "accepted");
  const a = o.actions.find((x) => x.action === "create_job");
  assert.equal(a.key, `create_job:${outOffer.offerId}`);
  assert.equal(a.payload.description, jobDescription(outOffer.terms));
  assert.equal(a.payload.expiredAt, outOffer.expiresAt);
  assert.deepEqual(o.ops[0], { op: "accept", offerId: outOffer.offerId, address: A, agentId: 10270 });
});
// unknown → unknown_offer; expired or under 1 h left → offer_expired; taken → offer_taken;
// wrong to.agentId or unbound identity → identity_mismatch; daily cap → capacity_exceeded (retryable: true)
test("accept errors map to their codes and leave the task rejected", ...);
test("an offer with gas.grant also enqueues gas_grant", ...);
test("a decline of our offer completes the task", ...);
test("a decline after the offer was accepted gets state_mismatch", ...);
test("a query by jobId returns chain state and next: ours → working, theirs → input-required", ...);
test("a submitted notice stores the deliverable reference and enqueues evaluate", ...);
test("a query for a missing job gets job_not_found", ...);
test("evaluate is never enqueued when we are not the evaluator", ...);
```

- [ ] **Paso 2:** `node --test jobs/handlers.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3:** implementar como funciones sin I/O. `text` es una línea en inglés que resume `next.note` o el error.
- [ ] **Paso 4:** el mismo comando. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/handlers.mjs jobs/handlers.test.mjs && git commit -m "feat(jobs): add pure handlers for offers and job messages"`

---

### Task 7: Adaptador de respuestas en texto

**Archivos:**
- Crear: `jobs/text_adapter.mjs`
- Test: `jobs/text_adapter.test.mjs`

**Interfaces:**
- Produce: `adaptTextReply(text, { findOffer }) → { name: "accept"|"decline", body } | null`, donde `findOffer(offerId)` devuelve un `OfferRow` o `null`.

**Reglas.** El texto tiene que traer exactamente un `of_[A-Za-z0-9]{10}` distinto, y `findOffer` tiene que devolverlo con `direction: "out"` y `state: "open"`. Si se cumple:
- **Una sola dirección `0x` (40 hex) distinta:** devuelve `accept { offerId, party: { address: getAddress(x), agentId } }`. El `agentId` sale de `offer.peerAgentId` o, si no está, de `/agentId[ ]?(\d+)/i` en el texto. Si no hay de dónde sacarlo, devuelve `null`.
- **Sin dirección y con `NO_WALLET`:** devuelve `decline { offerId, reason: "no_wallet" }`.
- **Cualquier otro caso:** `null`.

- [ ] **Paso 1: Escribir los tests que fallan**

```js
test("an offerId plus one address is an accept with a checksummed address", () =>
  assert.deepEqual(adaptTextReply(`ok ${OFFER_ID} ${A.toLowerCase()}`, { findOffer: () => outOfferRow }),
    { name: "accept", body: { offerId: OFFER_ID, party: { address: A, agentId: 10270 } } }));
test("two addresses are ambiguous", ...);
test("NO_WALLET is a decline", ...);
test("unknown, inbound or no-longer-open offers are ignored", ...);
test("the agentId comes from the text when the offer has none, and no agentId means null", ...);
```

- [ ] **Paso 2:** `node --test jobs/text_adapter.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3:** implementar con las regex de arriba.
- [ ] **Paso 4:** el mismo comando. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/text_adapter.mjs jobs/text_adapter.test.mjs && git commit -m "feat(jobs): parse plain-text replies to our offers"`

---

### Task 8: Runtime (procesar mensajes y registrar claims)

**Archivos:**
- Crear: `jobs/runtime.mjs`
- Test: `jobs/runtime.test.mjs`

**Interfaces:**
- **Consume:** las Tareas 1 a 7.
- **Produce:** `createJobsRuntime({ db, config, reader, clock = () => Math.floor(Date.now() / 1000), onAction = () => {}, onTaskUpdate = () => {}, log = () => {} }) → JobsRuntime`. Al crearse llama a `migrateJobsStore(db)`.
- **`JobsRuntime`** tiene estos miembros:
  - `store`
  - `detect(dataParts)`
  - `adaptText(text) → { name, body } | null`
  - `process({ detection, contextId, sender, messageId }) → Promise<ProcessResult>`
  - `recordOperatorClaim({ contextId, replyId, data }) → boolean`
  - `jsonSchema()`
- **`ProcessResult`** es una de estas formas:
  - `{ kind: "invalid", field, detail }`
  - `{ kind: "chain_unavailable" }`
  - `{ kind: "ok", name: "status"|"error"|null, body, text, taskState, actions }`
- **Callbacks:**
  - `onAction(row: ActionRow)` se llama por cada acción nueva una vez que la transacción se confirmó, y después se ejecuta `store.markWoken`.
  - `onTaskUpdate({ contextId, state, name, body, text })` lo usa el barrido de la Tarea 9.

**Algoritmo de `process`, en orden:**
1. **Detección inválida:** devuelve `{ kind: "invalid" }`.
2. **Mensaje ya visto:** si `seenResponse(sender ?? "anon", messageId)` existe, se devuelve esa respuesta.
3. **Parseo:**
   - lo legacy pasa por `normalizeLegacyOffer` y lo tipado por `parseTyped`;
   - si no valida, `invalid`;
   - si el nombre no está soportado, `error` `unsupported_key` con `taskState: "rejected"`.
4. **`status` y `error` que llegan:** se responde `{ kind: "ok", name: null, text: "Received.", taskState: "completed", actions: [] }`.
5. **Clave natural:**

   | Mensaje | Clave |
   |---|---|
   | `offer` | `offer:<offerId>` |
   | `accept` | `accept:<offerId>:<address>:<agentId>` |
   | `decline` | `decline:<offerId>` |
   | los demás | ninguna |

   Si `getReply(key)` existe y el hash del cuerpo es el mismo, se repite la respuesta; si el hash es distinto, `error` `idempotency_conflict` con estado `rejected`.
6. **Lecturas on-chain** según el nombre:
   - `accept`: `isBoundToAgent`;
   - avisos y `query` con `jobId`: `getJob`, `hasPendingClaim` y `blockTime`, más `submittedDeliverable` si el job está Submitted;
   - `offer`: `isAllowedToken`.

   Si alguna lanza `ChainUnavailable`, se devuelve `{ kind: "chain_unavailable" }` sin persistir nada.
7. **Handler.** Antes de llamarlo, los `counts` salen del store:
   - `openOffersForAgent` = `countOpenOffersForAgent(from.agentId)`, o 0 si la oferta no trae `from`;
   - `createJobsToday` = `countActionsSince("create_job", now − 86400)`.

   Si la respuesta trae `next.call.data`, se ejecuta `reader.simulate({ account: job.provider, to, data })` y el resultado se guarda en `next.simulation`, como `{ ok: true }` o `{ ok: false, reason }`.
8. **Persistencia.** Una sola transacción aplica los `ops`, encola las acciones (y guarda solo las nuevas), ejecuta `saveReply` si hay clave y `rememberResponse(sender, messageId, result)`.
9. **Cierre:** `onAction` y `markWoken` por cada acción nueva, y después se devuelve el resultado.

**`recordOperatorClaim`** es sincrónico, porque corre dentro de la transacción del outbox. Si `data` trae exactamente una clave `defigent.job.*` entre `created`, `funded`, `completed`, `rejected`, `expired`, `accept` y `decline`, ejecuta `recordClaim` y devuelve `true`.

- [ ] **Paso 1: Escribir los tests que fallan.** Usan una DB en memoria y `createFakeChain`.

```js
test("accepting our offer: status accepted, one create_job action, onAction called once", ...);
test("the same accept after a restart replays the stored reply without a second action", async () => {
  const db = new Database(":memory:");
  const r1 = createJobsRuntime({ db, config: cfg, reader: fake, clock }); r1.store.insertOffer(outOfferRow);
  const a = await r1.process(acceptReq("m1"));
  const r2 = createJobsRuntime({ db, config: cfg, reader: fake, clock });
  const b = await r2.process(acceptReq("m2")); // new messageId, same body
  assert.deepEqual(b.body, a.body);
  assert.equal(r2.store.listActions().filter((x) => x.action === "create_job").length, 1);
});
test("a different accept for a taken offer gets offer_taken", ...);
test("the same offerId with different terms gets idempotency_conflict", ...);
test("chain unavailable: nothing is persisted and a retry succeeds", async () => {
  const rt = createJobsRuntime({ db: new Database(":memory:"), config: cfg, reader: createFakeChain({ fail: true }), clock });
  assert.deepEqual(await rt.process(queryReq("m1")), { kind: "chain_unavailable" });
  assert.equal(rt.store.seenResponse("anon", "m1"), null);
});
test("a hanging chain is reported as chain_unavailable", ...);
test("a query returns next with the simulation result", ...);
test("a legacy offer is normalized and goes to review", ...);
test("status and error from peers are only logged", ...);
test("a duplicate messageId returns the remembered response", ...);
test("recordOperatorClaim takes only claim names and dedupes by replyId", ...);
test("adaptText turns 'of_… 0x…' into an accept for our open offer", ...);
```

- [ ] **Paso 2:** `node --test jobs/runtime.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3:** implementar el algoritmo de arriba.
- [ ] **Paso 4:** el mismo comando. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/runtime.mjs jobs/runtime.test.mjs && git commit -m "feat(jobs): add runtime that processes typed messages"`

---

### Task 9: Barrido periódico

**Archivos:**
- Crear: `jobs/sweep.mjs`
- Modificar: `jobs/runtime.mjs`, para agregar `sweep()`
- Test: `jobs/sweep.test.mjs`

**Interfaces:**
- Consume:
  - `JobsStore` (Tarea 3);
  - `ChainReader`, `nextStep` y `taskStateFor` (Tarea 4);
  - `parseJobDescription` (Tarea 2);
  - `statusBody` y los payloads de las acciones (Tarea 6).
- Produce:
  - `sweepJobs({ store, reader, config, now, onAction, onTaskUpdate, maxReads = 50 }) → Promise<{ claims, actions, updates }>`
  - `runtime.sweep()`, que tiene la misma salida

**Algoritmo:**
1. **Claims pendientes**, hasta `maxReads`:
   - **`created { offerId, jobId }`.** Se lee `getJob` y el claim es válido si se cumplen las cuatro condiciones:
     - `client == config.client`;
     - `provider == offer.acceptedAddress`;
     - `providerAgentId == offer.acceptedAgentId`;
     - `parseJobDescription(job.description)` coincide con `offerId` y con `offer.termsHash`.

     Si es válido: `linkJob`, `setChainStatus`, el claim queda `verified` y se llama `onTaskUpdate` con el `status`, el `next` y el estado de `taskStateFor`. Si no: el claim queda `rejected` con el motivo y se encola `review_claim:<id>`.
   - **`funded`, `completed`, `rejected` o `expired` (`{ jobId }`).** El estado on-chain tiene que coincidir con el del claim. Si coincide, el claim queda `verified`, se ejecuta `markJobTerminal` en los tres últimos y se llama `onTaskUpdate`. Si no, el claim queda `rejected` y se encola `review_claim`.
   - **`accept` y `decline`**, que son veredictos sobre una oferta entrante:
     - `accept` exige que `isBoundToAgent(party)` dé verdadero; entonces se ejecutan `acceptOffer` y `setOfferState("accepted")`, y se encola `create_job`;
     - `decline` ejecuta `setOfferState("declined")`;
     - en los dos casos se llama `onTaskUpdate`.
2. **Jobs abiertos**, con `openJobOffers` y hasta agotar las lecturas: se leen `getJob`, `hasPendingClaim` y `blockTime`, y se calcula `nextStep`.
   - Si el estado cambió: `setChainStatus` y `onTaskUpdate`.
   - Si es terminal: `markJobTerminal`.
   - Si `next.ours` y hay `next.action`: `enqueueAction`, con las claves de la Tarea 6.
3. **Despertar acciones:** para cada acción de `unwokenActions(20)` se llaman `onAction` y `markWoken`.
4. **Errores:** si salta `ChainUnavailable`, la vuelta termina ahí y devuelve lo que alcanzó a procesar. El ítem en curso no deja nada a medio persistir.

- [ ] **Paso 1: Escribir los tests que fallan**

```js
test("a verified created claim links the job and moves the offer task to setBudget", ...);
test("a created claim with the wrong provider is rejected and raises review_claim", ...);
test("silent submit: a Submitted job without a notice gets evaluate with the grace deadline", ...);
test("a Submitted job someone already refunded (Expired) gets no evaluate and turns terminal", ...);
test("a Funded job past expiry with a pending claim gets no refund", ...);
test("a Funded job past expiry gets refund only once across two sweeps", ...);
test("actions enqueued by a script are woken exactly once", ...);
test("maxReads bounds the chain reads per sweep", ...); // fake.calls
test("chain unavailable stops the sweep without changing state", ...);
```

- [ ] **Paso 2:** `node --test jobs/sweep.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3:** implementar `sweepJobs` y agregar `sweep: () => sweepJobs({ store, reader, config, now: clock(), onAction, onTaskUpdate })` al runtime.
- [ ] **Paso 4:** `node --test jobs/*.test.mjs`. Esperado: PASS.
- [ ] **Paso 5:** `git add jobs/sweep.mjs jobs/runtime.mjs jobs/sweep.test.mjs && git commit -m "feat(jobs): add periodic sweep for claims, silent submits and expiries"`

---

### Task 10: Inbox, el desvío tipado

**Archivos:**
- Modificar `http_server.mjs`:
  - los imports, junto a `:154`;
  - la creación del runtime, después de las tablas (`:251`);
  - el desvío, justo después de `fileParts` (`:703`) y antes del `Set` de dedupe (`:709`);
  - `wakeQueueLine` (`:568-585`), para que incluya `action`;
  - el bloque del webhook (`:832-842`), que pasa a ser la función `notifyHermes(wakeLine)`.
- Modificar `a2a_inbox.test.mjs`: agregar un `describe` nuevo al final, el helper `startChainStub` y el helper de escritura `seedJobs(h, fn)`.

**Interfaces:**
- Consume: `loadJobsConfig`, `createChainReader`, `createJobsRuntime` y las funciones de `jobs/wire.mjs`.
- Produce, dentro de `http_server.mjs`:
  - `const JOBS_CONFIG = loadJobsConfig()`
  - `const jobs = createJobsRuntime({ db: a2a, config: JOBS_CONFIG, reader: createChainReader({ config: JOBS_CONFIG, rpcUrl: RPC }), onAction: wakeTypedAction, onTaskUpdate: applyTypedTaskUpdate })`
  - `wakeTypedAction(row)`
  - `applyTypedTaskUpdate({ contextId, state, name, body, text })`
  - `notifyHermes(wakeLine)`

**Comportamiento del desvío:**
1. **Detección.**
   - `let detection = jobs.detect(dataParts)`.
   - Si da `none` y hay texto, se prueba `jobs.adaptText(text)`. Si devuelve algo, `detection = { kind: "typed", ...adaptado }`.
2. **Procesamiento**, cuando `detection.kind !== "none"`:
   - `contextId` se calcula con la misma expresión que `:722` y la identidad con `verifyAuth`, igual que en `:716-719`;
   - `version = negotiateVersion(verHeader)`;
   - `r = await jobs.process({ detection, contextId, sender: ident.address || declaredSender, messageId })`.
3. **Si `r` es `invalid`:** se responde `res.json(invalidParams(…))` y se corta ahí, sin crear tarea ni guardar mensajes.
4. **Si `r` es `chain_unavailable`:** se responde `res.json(chainUnavailable(…))` y se corta ahí.
5. **Si `r` es `ok`:**
   1. `addMessage` del usuario, con el texto o `"(typed defigent.job.<name>)"`, y con `meta` = `{ data: dataParts, files: fileParts }`.
   2. Si el mensaje era legacy, el mismo insert del artifact `received-offer` de `:809-820`.
   3. `upsertTask(contextId, r.taskState)`.
   4. `addMessage` del agente con `r.text`, y `meta` con la respuesta tipada cuando hay `name`.
   5. `logInbox` con `cls: "typed_<name>"`.
   6. El header de eco que devuelve `extensionsEcho`.
   7. `res.json({ jsonrpc: "2.0", id, result: typedResult(…) })`. Si es stream, en cambio, se escribe un solo `sseFrame` con esa respuesta y se cierra.

**Funciones auxiliares:**
- **`wakeTypedAction(row)`:**
  1. `wakeQueueLine({ ts: Date.now(), contextId: row.contextId, cls: "typed_action", verified: true, sender: null, preview, replyExpected: true, action: { key, action, payload } })`;
  2. agrega la línea al final de `WAKE_QUEUE_FILE`;
  3. llama a `notifyHermes(line)`.
- **`applyTypedTaskUpdate`** ejecuta `upsertTask` y `addMessage` del agente con la parte tipada en `meta`.

**Tests de integración.**
- **El stub de cadena.** `startChainStub({ jobs, bindings, allowed, now, deliverables })` es un servidor JSON-RPC local que responde así:
  - `eth_call`: lo decodifica con `decodeFunctionData`, eligiendo el ABI según el `to`, y contesta con `encodeFunctionResult`;
  - la simulación de `setBudget`: contesta `0x`;
  - `eth_getBlockByNumber`: un bloque mínimo que viem pueda formatear (`number`, `hash`, `timestamp`, `transactions: []`, …);
  - `eth_getLogs`: logs `JobSubmitted`.
- **El arranque:** `Harness.start({ rpcUrl: stub.url, env: { DEFIGENT_JOBS_SWEEP_MS: "200" } })`.
- **Presupuesto:** cada harness tiene 10 mensajes, así que se usa `h.restart()` entre grupos.
- **`seedJobs`:** abre en modo escritura la misma DB que lee `db()` y usa `createJobsStore`.

```js
it("a typed query with A2A-Version 1.0 returns a 1.0 task with the next step", async () => {
  const r = await h.post(msgReq("tj-1", [{ data: { "defigent.job.query": { jobId: "42" } } }]), { headers: { "A2A-Version": "1.0" } });
  assert.equal(r.json.result.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  assert.equal(r.json.result.task.status.message.parts[0].data["defigent.job.status"].next.function, "setBudget(uint256,address,uint256,bytes)");
});
it("the same query without a version header returns the 0.3 shape", ...); // result.kind "task", state "input-required", parts[0].kind "data"
it("an invalid typed body gets -32602 with BadRequest and creates no task", ...); // GET /tasks/<ctx> → 404
it("a typed part wins over a digest phrase in the text", ...); // parts: text 'sha256 hash of "abc"' + query → status, no digest artifact
it("legacy offer_schema_v1 is answered typed, keeps the received-offer artifact and queues review_offer", ...);
it("with the RPC down the typed request gets -32603 CHAIN_UNAVAILABLE", ...); // harness with DEAD_RPC
it("a text reply 'of_… 0x…' to our open offer is handled as an accept", ...); // seedJobs inserts the offer
it("the A2A-Extensions header is echoed when the client lists the URI", ...);
```

- [ ] **Paso 1:** escribir los tests de arriba.
- [ ] **Paso 2:** `node --test --test-name-pattern "typed jobs protocol" a2a_inbox.test.mjs`. Necesita salida de red a los facilitadores de x402. Esperado: FAIL.
- [ ] **Paso 3:** implementar el desvío y las funciones de arriba.
- [ ] **Paso 4:** el mismo comando da PASS. Además, la suite completa `node --test a2a_inbox.test.mjs` tiene que pasar entera, con los tests de antes sin cambios.
- [ ] **Paso 5:** `git add http_server.mjs a2a_inbox.test.mjs && git commit -m "feat(inbox): route typed defigent.job messages through the jobs runtime"`

---

### Task 11: Claims del outbox y programación del barrido

**Archivos:**
- Modificar: `http_server.mjs`, en `applyOutboxLine` (`:265-298`) y en la programación junto a `:423`
- Modificar: `a2a_inbox.test.mjs`

**Comportamiento:**
- **Outbox.** Dentro de la transacción de `applyOutboxLine`, después de aplicar la respuesta como hoy, si viene `o.data` se llama a `jobs.recordOperatorClaim({ contextId: o.contextId, replyId: o.replyId ?? null, data: o.data })`. El texto y el estado se aplican igual que siempre.
- **Barrido:**
  - Se programa con `setInterval(runJobsSweep, JOBS_CONFIG.sweepMs).unref()`.
  - Un flag `sweeping` impide que se pisen dos vueltas.
  - Los errores se registran con `logInbox({ ts, cls: "jobs_sweep_error", error })`, con el error cortado a 200 caracteres.

- [ ] **Paso 1: Escribir los tests que fallan**

```js
it("an operator 'created' claim is verified on-chain and moves the offer task to setBudget", ...);
it("a claim with the wrong provider is rejected and raises a review_claim wake line", ...);
it("a create_job action enqueued directly in the DB is woken by the sweep", ...);
it("an operator decline verdict on an inbound offer closes its review", ...);
```

- [ ] **Paso 2:** `node --test --test-name-pattern "typed jobs protocol" a2a_inbox.test.mjs`. Esperado: FAIL en los nuevos.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** el mismo comando y la suite completa. Esperado: PASS.
- [ ] **Paso 5:** `git add http_server.mjs a2a_inbox.test.mjs && git commit -m "feat(inbox): verify operator results and run the jobs sweep"`

---

### Task 12: Card, esquema, spec e `/integration`

**Archivos:**
- Modificar `http_server.mjs`: la card (`:116-149`), `/integration` (`:1160+`) y las rutas nuevas.
- Crear `docs/a2a-ext-erc8183-jobs-v1.md`, en inglés.
- Modificar `a2a_inbox.test.mjs`.

**Comportamiento:**
- **Card:** `capabilities.extensions = [jobsExtension, identityExtension]`.
  - `jobsExtension` es `{ uri: EXT_URI, description: "Typed ERC-8183 job offers and lifecycle messages as A2A DataParts.", required: false, params: { chainId: 143, escrow, tokens: [USDC], schema: JOBS_CONFIG.schemaUrl } }`.
  - `identityExtension` es el mismo objeto que hoy está en `extensions` en el nivel superior, que no cambia.
  - El skill `jobs` suma `" Typed messages: " + EXT_URI` a su descripción.
- **Rutas nuevas:**
  - `GET /schemas/erc8183-jobs-v1.json` responde `res.json(jobs.jsonSchema())`;
  - `GET /a2a/ext/erc8183-jobs/v1` responde con `text/markdown`, leyendo el archivo desde una ruta resuelta con `import.meta.url` y no con el cwd.
- **`/integration`:**
  - suma `jobs_protocol_v1 { extension, schema, spec, example_query, example_accept }`;
  - `offer_schema_v1` suma `status: "legacy: still accepted, normalized to defigent.job.offer"`.
- **La spec en inglés** cubre:
  - el URI y la activación (los dos headers, `required: false`);
  - el sobre (un DataPart, una clave, TextParts orientativos, formas 0.3 y 1.0);
  - las 13 claves con sus campos;
  - el ciclo de vida y `next`, con `simulation`;
  - el mapeo de estados;
  - los errores (`-32602`, `-32603` y los códigos de negocio);
  - la idempotencia;
  - el formato de `description` on-chain;
  - el versionado.

- [ ] **Paso 1: Escribir los tests que fallan**

```js
it("the card declares the jobs extension in capabilities.extensions and keeps the top-level array", ...);
it("GET /schemas/erc8183-jobs-v1.json lists the 13 keys", ...);
it("GET /a2a/ext/erc8183-jobs/v1 serves the markdown spec with the URI", ...);
it("/integration documents jobs_protocol_v1 and marks offer_schema_v1 as legacy", ...);
```

- [ ] **Paso 2:** `node --test --test-name-pattern "typed jobs protocol" a2a_inbox.test.mjs`. Esperado: FAIL en los nuevos.
- [ ] **Paso 3:** implementar y escribir la spec.
- [ ] **Paso 4:** el mismo comando y la suite completa. Esperado: PASS.
- [ ] **Paso 5:** `git add http_server.mjs docs/a2a-ext-erc8183-jobs-v1.md a2a_inbox.test.mjs && git commit -m "feat(inbox): publish the jobs extension, schema and spec"`

---

### Task 13: Cliente A2A y `send_offer`

**Archivos:**
- Crear: `jobs/a2a_client.mjs` y `scripts/send_offer.mjs`
- Test: `jobs/a2a_client.test.mjs`

**Interfaces:**
- Consume: `EXT_URI`, `fullKey`, `newOfferId`, `termsHash`, `loadJobsConfig`, `createChainReader`, `createJobsRuntime` y `createJobsStore`.
- Produce:
  - `buildTypedMessage({ name, body, contextId, text, messageId = crypto.randomUUID() }) → object`. Tiene la forma 0.3: `kind: "message"`, `role: "agent"`, las partes `[{ kind: "data", data: { [fullKey(name)]: body } }, { kind: "text", text }]`, más `extensions: [EXT_URI]` y `contextId`.
  - `sendTyped({ endpoint, message, fetchImpl = fetch, timeoutMs = 15000 }) → Promise<{ status, result?, error? }>`. Hace POST de `message/send` con `A2A-Extensions` y `X-A2A-Extensions` puestos en `EXT_URI`. No manda `A2A-Version`, así que el peer lo lee como 0.3.
  - `extractTyped(result) → Array<{ name, body }>`. Busca en la Task o el Message de 0.3 y en `{ task }` o `{ message }` de 1.0, dentro de `status.message.parts`, `history[].parts`, `artifacts[].parts` y `parts`.

**El script `scripts/send_offer.mjs`:**
- **Uso:** `--endpoint <url> --agent-id <n> --service <id> --description <texto> --amount <unidades base> [--token USDC] [--ttl <s>] [--dry-run]`
- **Preparación:**
  1. Carga la config y abre `${DEFIGENT_DATA_DIR:-/home/ubuntu/.hermes/cache/scratch}/defigent_a2a.db`.
  2. Corta con un error si `countOpenOffersForAgent(agentId) ≥ caps.maxOpenOffersPerAgent` o si el monto supera `caps.maxOfferAmount`.
- **La oferta que arma:**
  - `side: "client"`;
  - `from: { address: config.client, agentId: config.agentId }`;
  - `to: { agentId }`;
  - `replyTo: { url: config.inboxUrl, contextId: offerId }`;
  - `expiresAt = now + max(ttl, minOfferTtlSeconds)`;
  - `settlement`, `price` y `deliverable { acceptance: "operator" }`;
  - `providerSteps: ["setBudget", "submit"]` y `gas { providerTxs: 2, grant: null }`;
  - un texto de un párrafo en inglés que explica cómo se cobra.
- **Envío:**
  - Con `--dry-run`, imprime el mensaje y sale.
  - Si no:
    1. registra la oferta con `insertOffer` (`direction: "out"`, `contextId = offerId`, `state: "open"`);
    2. la manda con `sendTyped`;
    3. pasa cada resultado de `extractTyped` por `runtime.process`;
    4. imprime un resumen.

- [ ] **Paso 1: Escribir los tests que fallan**

```js
test("buildTypedMessage uses the 0.3 shape and lists the extension", ...);
test("sendTyped posts message/send with both extension headers and no version header", ...); // fake fetch
test("extractTyped finds typed parts in 0.3 tasks, 1.0 {task} results and plain messages", ...);
test("extractTyped ignores data parts without defigent.job keys", ...);
```

- [ ] **Paso 2:** `node --test jobs/a2a_client.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3:** implementar el cliente y el script.
- [ ] **Paso 4:** el test da PASS, y `node scripts/send_offer.mjs --dry-run --endpoint https://example.invalid/inbox --agent-id 10270 --service a2a-conformance-probe --description "Answer tasks/get with -32001" --amount 250000` imprime un JSON con `"defigent.job.offer"`.
- [ ] **Paso 5:** `git add jobs/a2a_client.mjs jobs/a2a_client.test.mjs scripts/send_offer.mjs && git commit -m "feat(jobs): add typed A2A client and send_offer script"`

---

### Task 14: Transacciones, `jobs_actions` y docs del operador

**Archivos:**
- Crear: `jobs/tx.mjs` y `scripts/jobs_actions.mjs`
- Test: `jobs/tx.test.mjs`
- Modificar: `docs/operator-outbox.md`

**Interfaces:**
- **Consume:** `ESCROW_ABI`, `ERC20_ABI`, `JobsConfig`, `ActionRow`, `sendTyped`, `buildTypedMessage` y `createJobsStore`.
- **Produce:**
  - `buildActionTxs(action, config, { verdict?: "complete"|"reject"|"accept"|"decline", reason? } = {}) → Array<{ label, to, data, value?: bigint, gasFloor?: bigint }>`
  - `outboxLineFor(action, { txHash?, jobId?, verdict?, party? }) → { contextId, text, state, data, replyId }`
- **Transacciones por acción:**

  | Acción | Transacciones |
  |---|---|
  | `create_job` | `createJob(provider, evaluator, expiredAt, description, hook, agentId)` |
  | `fund` | `approve(escrow, amount)` sobre el token y después `fund(jobId, token, amount, "0x")` |
  | `evaluate` con `complete` | `complete(jobId, keccak256(toBytes(reason ?? "accepted")), "0x")`, con `gasFloor: 700000n` |
  | `evaluate` con `reject` | `reject(jobId, keccak256(toBytes(reason ?? "rejected")), "0x")` |
  | `refund` | `claimRefund(jobId)` |
  | `gas_grant` | `{ to, value: BigInt(amountWei), data: "0x" }` |
  | `review_offer` y `review_claim` | ninguna, solo la línea de outbox |

  `evaluate` sin veredicto lanza `verdict required`.
- **Líneas de outbox.** Todas llevan `replyId = action.key`.

  | Acción | `data` | Estado |
  |---|---|---|
  | `create_job` | `{ "defigent.job.created": { offerId, jobId, txHash } }` | `input-required` |
  | `fund` | `funded` | `input-required` |
  | `evaluate` con `complete` | `completed` | `completed` |
  | `evaluate` con `reject` | `rejected` | `failed` |
  | `refund` | `expired` | `failed` |
  | `review_offer` aceptada | `accept { offerId, party }` | `working` |
  | `review_offer` rechazada | `decline { offerId, reason: "other" }` | `completed` |

- **El script `scripts/jobs_actions.mjs`.** Tiene dos subcomandos.
  - **`list`** imprime las acciones pendientes.
  - **`apply <key> [--verdict …] [--reason …] [--party-address 0x… --party-agent-id N] [--dry-run]`** sigue estos pasos:
    1. Arma las transacciones. Con `--dry-run`, las imprime y sale.
    2. Toma la cuenta de `DEFIGENT_PRIVATE_KEY`; se corre con `node --env-file=/home/ubuntu/.hermes/.env`. Antes de seguir, verifica que su dirección sea `config.client` (create, fund, refund, gas) o `config.evaluator` (evaluate).
    3. Por cada transacción, la simula con `eth_call` desde la cuenta y, si revierte, aborta mostrando el motivo.
    4. La envía con `gasPrice × 1.1` y `gas = max(estimación × 1.3, gasFloor)`, como `dogfood_e2e.mjs:33-47`, y espera un receipt `success`.
    5. En `create_job`, saca el `jobId` del log `JobCreated` (`topics[1]`).
    6. Ejecuta `finishAction(key, "done", result)` y agrega la línea al outbox `${DEFIGENT_DATA_DIR}/defigent_outbox.jsonl`.
    7. Manda el aviso tipado a `offer.peerEndpoint` con `sendTyped`. Es best effort: si falla, lo registra y sigue.

    Nunca imprime la clave.
- **`docs/operator-outbox.md`** suma la sección "Acciones tipadas", en español, con cuatro puntos:
  - la línea de wake (`cls: "typed_action"`, `action { key, action, payload }`);
  - cómo usar `list` y `apply`;
  - las líneas de resultado;
  - que el inbox las verifica on-chain antes de tocar el ledger.

- [ ] **Paso 1: Escribir los tests que fallan**

```js
test("create_job encodes createJob with the canonical description and the configured hook", ...);
test("fund approves the exact amount before funding", () =>
  assert.deepEqual(buildActionTxs(fundAction, cfg).map((t) => t.label), ["approve", "fund"]));
test("evaluate complete has a 700000 gas floor and needs a verdict", ...);
test("refund calls claimRefund(jobId)", ...);
test("outbox lines carry the action key as replyId and the typed result", ...);
```

- [ ] **Paso 2:** `node --test jobs/tx.test.mjs`. Esperado: FAIL.
- [ ] **Paso 3:** implementar `tx.mjs`, el script y el doc.
- [ ] **Paso 4:** el test da PASS. Además, con una acción sembrada, `DEFIGENT_DATA_DIR=<tmp> node scripts/jobs_actions.mjs apply create_job:of_AAAAAAAAAA --dry-run` imprime la transacción `createJob`.
- [ ] **Paso 5:** `git add jobs/tx.mjs jobs/tx.test.mjs scripts/jobs_actions.mjs docs/operator-outbox.md && git commit -m "feat(jobs): add action runner and document typed operator actions"`

---

### Task 15: Verificación final

- [ ] `node --test jobs/*.test.mjs`. Esperado: todo PASS.
- [ ] `node --test a2a_inbox.test.mjs`, que necesita red y tarda varios minutos. Esperado: todo PASS, incluidos los tests de antes.
- [ ] `pnpm test`. Esperado: PASS.
- [ ] **Smoke de solo lectura contra mainnet.**
  1. Levantar el servidor: `DEFIGENT_DATA_DIR=$(mktemp -d) PORT=18080 node http_server.mjs`.
  2. Mandar una consulta tipada por el job 21:

     ```bash
     curl -s localhost:18080/inbox -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"ROLE_USER","messageId":"smoke-1","parts":[{"data":{"defigent.job.query":{"jobId":"21"}}}]}}}'
     ```

  3. Verificar que `result.task.status.message.parts[0].data["defigent.job.status"].job.chainStatus` es el estado real del job 21.
  4. Frenar el servidor.
- [ ] `git fetch origin && git rebase origin/main`, y volver a correr los tests unitarios.
- [ ] El PR se abre siguiendo `superpowers:finishing-a-development-branch`, después de la revisión de toda la rama.
