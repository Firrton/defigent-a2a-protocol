# Investigación: stack agéntico de Base → port ERC-8183 a Monad

Fecha: 2026-10-13. Alcance: respuestas 1-5 pendientes + plan de port. No re-cubre lo ya conocido (spec ERC-8183, ACP v2, addresses Base, SDK, PayAI, AgentPMT).

## 1. Código open-source de la reference implementation ERC-8183

**Repo oficial: https://github.com/erc-8183/base-contracts** (org `erc-8183`, MIT, 100% Solidity, Foundry, 79 commits, último merge jun-2026: meta-transactions y claims vía PR #24 de okx).

Archivos exactos:

- `https://github.com/erc-8183/base-contracts/blob/main/contracts/ERC8183.sol` — core: state machine `Open → Funded → Submitted → Completed | Rejected | Expired`, escrow, fees, hooks, UUPS proxy (OpenZeppelin), pausable, CEI + reentrancy guard transient, allowlist de tokens de pago, grace period de 1h para el evaluador post-expiry.
- `https://github.com/erc-8183/base-contracts/blob/main/contracts/IERC8183Hook.sol` — hook interface (`beforeAction` / `afterAction`).
- `ERC8183WithAuthorization.sol` — extensión EIP-712 para llamadas relayadas (ERC-2771 style).
- `IDisburser.sol` — callback de payout.
- `mocks/` — MockUSDC (6 dec), MockCBBTC (8 dec), MockFeeOnTransferToken, etc.
- Docs: `docs/01-architecture.md`, `docs/02-hook-system.md`, `docs/03-demo-flows.md`.

Nota de naming: la spec (eip-8183) llama al contrato de referencia `AgenticCommerce.sol`, pero en el repo canónico el core es `ERC8183.sol` — misma pieza. El repo declara GOVERNANCE.md y MAINTAINERS.md con contributors de Virtuals (psmiratisu aparece también como committer en `acp-node-v2`, lo que confirma que es el equipo de ACP v2).

Repo secundario (tercero, no oficial): `https://github.com/Zhekinmaksim/ERC8183base` — proyecto Foundry que dice estar deployado en Base mainnet. No verificamos su deployment.

## 2. ¿Source-verified en basescan?

**El impl no aparece verificado; el proxy sí.**

- `0x238E541BfefD82238730D00a2208E5497F1832E0` = proxy ERC1967 estándar. Verificado en Blockscout (`is_verified: true`, compilador v0.8.28, proxy_type eip1967) — verificación estándar de OpenZeppelin.
- `0x90717828D78731313CB350D6a58b0f91668Ea702` = impl. On-chain responde a los getters `platformFeeBP()` / `platformTreasury()` / `evaluatorFeeBP()` vía el proxy (eth_call OK), y su bytecode es grande con dispatcher de selectores. Pero ni Blockscout (`/api/v2/smart-contracts/0x9071...` devuelve solo bytecode fields, sin `name`/`language`/`compiler_version` — la forma que la API devuelve para contratos no verificados) ni la página de basescan muestran nombre de contrato ni source. Basescan lo etiqueta solo como "Virtuals Protocol: Deployer 1" (creator label).
- Advertencia de método: la API v1 de basescan está deprecada y detrás de Cloudflare, y la v2 exige API key; la conclusión se basa en Blockscout (explorer alternativo de Base) + DOM de basescan. Es señal fuerte pero no un veredicto oficial de basescan. Consecuencia práctica para el port: **hay que recompilar desde el repo canónico** (no confiar en una copia de la source del explorer) y re-verificar por nosotros al deployar en Monad.

## 3. ¿Alguien deployó ERC-8183/ACP en Monad?

**No encontramos ninguna deployment en Monad.**

- `eth_getCode` en `rpc.monad.xyz` de ambas addresses de Base → `0x` (vacío) para las dos. Si fuera CREATE2/determinista, tampoco hay código ahí.
- Búsquedas web (`erc-8183 monad`, `ACP monad virtuals deploy`) no devuelven ningún deployment ni announcement de ACP v2 en Monad.
- En el SDK (`acp-node-v2`), `src/core/chains.ts` **sí importa `monad` de `viem/chains`** y lo incluye en la lista de cadenas del client ERC-20 — el soporte de red existe a nivel SDK, pero el registro de addresses de contratos ACP que vimos publicado en commits recientes (Arc mainnet/testnet, Solana) no menciona Monad. Monad está preparado como red en viem, no como deployment de ACP.

Conclusión: Monad es territorio libre. Sería (hasta donde llega esta investigación) el primer deployment de ERC-8183 ahí.

## 4. Fee / cut de ACP v2 al settle

Leído on-chain vía `eth_call` al proxy `0x238E...` en Base (base.drpc.org), los getters existen en el impl y coinciden con `ERC8183.sol` del repo canónico:

- `platformFeeBP()` = `0x1f4` = **500 bps = 5%** → va a `platformTreasury()` = `0x3f833be7447f82e8654bc634981899db0ee8042e`.
- `evaluatorFeeBP()` = `0x1f4` = **5%** → va al `job.evaluator` de cada job.

Lógica exacta (`_distributeSettlement` en ERC8183.sol): sobre el `delta` settleado en cada settle (parcial o total):

```
platformFee = delta * platformFeeBP / 10000   → safeTransfer(treasury) + PlatformFeePaid
evalFee     = delta * evaluatorFeeBP / 10000  → safeTransfer(job.evaluator) + EvaluatorFeePaid
net         = delta - platformFee - evalFee   → payout al proveedor (o disburser)
```

**Cut total: 10%** (5% plataforma + 5% evaluador). Ojo: el fee del evaluador es un incentivo, no un impuesto — en ACP el cliente suele ser su propio evaluador, en cuyo caso el 5% de evaluador vuelve a él. Si somos nosotros ambos lados, el coste neto real es 5%. Los fees son ajustables por admin (`PlatformFeeUpdated` / `EvaluatorFeeUpdated`).

## 5. ¿Provider con EOA externa (sin Privy smart wallet)?

**No hay adapter oficial de EOA/viem directo. Solo dos adapters publicados en el README:**

- `PrivyAlchemyEvmProviderAdapter` — Privy wallets + infra Alchemy (el ejemplo obliga `walletId` de Privy, `signerPrivateKey` generado desde la pestaña Signers de app.virtuals.io, `chains: [base]` de `@account-kit/infra`).
- `SolanaProviderAdapter`.

**Pero la superficie es extensible por diseño**: todos los adapters EVM implementan `IEvmProviderAdapter`, una interfaz documentada y estable:

```
sendCalls(chainId, calls)
signMessage(chainId, message)
signTypedData(chainId, typedData)   // para compat v1
getTransactionReceipt(chainId, hash)
readContract(chainId, params)
getLogs(chainId, params)
```

Un adapter custom sobre viem con una EOA (o con nuestro signador propio) es viable: basta implementar esas 6 funciones. Riesgo conocido: los comentarios internos de `chains.ts` indican que el transporte de pagos pasa por un "ACP wallet proxy" (sponsor/paymaster) — la ruta `sendTransaction()` de una sola llamada falla para cadenas que no estén en la lista interna, así que un adapter EOA probablemente pierda el gas sponsorship que el path Privy/Alchemy sí tiene. Para Monad eso da igual: si deployamos contrato propio ahí, el gas es nuestro problema y el gas en Monad es barato.

Requisito que no cambia con el adapter: la **registración como provider** sigue pasando por el Service Registry (app.virtuals.io/acp/join) — wallet + signer + offering. Eso es la capa de discovery de ACP; con port propio a Monad usando contrato directo, esa registración no es necesaria.

---

## Port ERC-8183 a Monad: plan mínimo viable

Objetivo: mismo modelo de escrow/jobs (client → fund → provider submit → evaluator attest) en Monad con USDC nativo `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, hooks que escriban reputación hacia nuestro ERC-8004, y el inbox A2A v1.0.1 como canal de negociación. Asumimos el rol de deployer+admin del contrato (no copiamos el registry de Virtuals).

### Paso 0 — Setup del repo
Fork/clone `erc-8183/base-contracts` (Foundry ya configurado). Renombrar/ajustar nada: `ERC8183.sol` es agnóstico de red.
**Esfuerzo: horas.**

### Paso 1 — Deploy en Monad
- `forge install && forge build && forge test` (los mocks corren local).
- Adaptar el deploy script: `initialize(treasury=nuestro admin, admin=nuestro multisig/EOPS)`, y agregar `0x754704Bc...` (USDC nativo Monad) al **allowlist de payment tokens** (el contrato solo acepta tokens veteados por admin). Ojo con decimales: USDC Monad 6 dec igual que Base.
- UUPS proxy + impl, verificar en el explorer de Monad con la source del repo canónico (el impl de Base NO está verificado — no dependemos de descompilación).
- Gas en Monad: trivial (300ms blocks), coste por job ~centavos.
**Esfuerzo: 0.5-1 día** (incluye allowlist + verificación).

### Paso 2 — Fee config propia
Decidir `platformFeeBP` / `evaluatorFeeBP` para nuestro deployment: no estamos obligados al 5%+5% de Virtuals (somos el admin). Opciones: 0+0 (captación pura por reputación al principio), o fee bajo (p.ej. 100 bps) para cubrir op. Los fees se setean post-initialize vía admin.
**Esfuerzo: horas** (decisión + 2 tx).

### Paso 3 — Hook de reputación → ERC-8004
Contrato propio `ReputationHook` implementando `IERC8183Hook` (`beforeAction` para gate: p.ej. exigir que el evaluator sea un ERC-8004 válido; `afterAction` para escribir feedback/reputación en nuestro registro ERC-8004 al `Completed`/`Rejected`). Eventos de job (`jobId`, roles, delta) ya son suficientes para indexar — el hook permite escribir on-chain o solo emitir y agregar off-chain.
Detalles de seguridad del hook (del repo): `claimRefund` NO es hookable; los hooks se whitelistan por admin.
**Esfuerzo: 2-4 días** (es el paso con diseño real: qué es reputación para nosotros y cómo mapea jobId → agentId ERC-8004).

### Paso 4 — Canal A2A: inbox v1.0.1 como transport
Reemplazar el rol del SSE/chat de ACP por nuestro inbox A2A existente: negociación (budget, deliverable, SLA) por A2A; el contrato solo ve `createJob → fund → submit → complete/reject`. El estado on-chain es la fuente de verdad; el inbox porta los payloads (requirement JSON + deliverable URI). Con blocks de 300ms el ciclo completo de job puede ser intra-segundo si las 3 partes están online — eso es la ventaja explotable (comparado con ~15 eventos/hora de ACP en Base, que cuelan lentos).
**Esfuerzo: 1-2 días** (mapeo de mensajes A2A → calls del contrato; probablemente ya tenemos la mayoría del plumbing).

### Paso 5 — Cliente/SDK mínimo
Sin `acp-node-v2` en Monad (no hay registry ahí): cliente propio con viem apuntando a `rpc.monad.xyz` + el ABI del repo (~6 funciones: createJob, fund, submit, settle/approve, claim, refund). El watcher de eventos (`getLogs` con filtro `JobFunded/JobSubmitted`) puede reusar el patrón del inbox A2A.
**Esfuerzo: 1-2 días.**

### Total realista
~1 semana de trabajo para MVP funcional (deploy + fee + inbox como canal), ~2 semanas si el hook de reputación ERC-8004 es sofisticado. Los únicos pasos con riesgo real de diseño son el Paso 3 (mapa de reputación) y la decisión de si el evaluator será siempre nosotros (cutoff simple) o terceros (necesita staking/slashing más adelante, fuera del MVP).

### Riesgos conocidos
- Somos admin del contrato: sin registry de Virtuals, la confianza depende de que el contrato esté verificado y de la reputación ERC-8004 acumulada. Buena razón para verificación limpia desde el día 1.
- `ERC8183WithAuthorization` (meta-tx) opcional: si los clientes agentes pagan gas directo, MVP no lo necesita.
- El fee del evaluador (5%) es incentivo al attestor honesto; si el evaluador es el propio cliente, es round-trip. Si más adelante abrimos evaluadores terceros, ese fee ya está soportado por el contrato.

## Fuentes

- Repo: https://github.com/erc-8183/base-contracts (contracts/, docs/, eip.md, README)
- ERC-8183 spec: https://eips.ethereum.org/EIPS/eip-8183
- On-chain Base (base.drpc.org): `eth_getCode` 0x238E (ERC1967 proxy, 137 bytes) y 0x9071 (impl, dispatcher grande); `eth_call` platformFeeBP()/evaluatorFeeBP()/platformTreasury()
- Blockscout Base: /api/v2/smart-contracts/{0x238E...,0x9071...}
- Monad: `eth_getCode` rpc.monad.xyz para ambas addresses → 0x
- SDK: https://github.com/Virtual-Protocol/acp-node-v2 — README (Provider Adapters, Prerequisites, JobSession) y src/core/chains.ts (import `monad` de viem/chains)
- Fee split: `_distributeSettlement` en contracts/ERC8183.sol del repo canónico
