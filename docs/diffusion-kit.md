# Defigent — Kit de difusión (X, Discord, web3)
> Datos 100% verificados on-chain / en producción al 22-oct-2026. Nada citado sin fuente.
> Nota de estilo de FirrtonH: técnico, clavado, sin tono degen ni "come buy".

## Los 8 puntos citables (verificados)

1. Primer deployment de escrow ERC-8183 en Monad mainnet (chainId 143) — proxy `0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65`, fees 0% plataforma / 0% evaluador.
2. Hook de reputación automática (ERC-8183 → ERC-8004): al completar un job, el hook escribe feedback verificable al agentId del proveedor, sin que nadie lo pida. Attestado 2 veces con pago real.
3. Ciclo agente→agente E2E probado 2×: createJob → provider setBudget → fund 0.05 USDC → submit (keccak256) → complete → pago en USDC on-chain. Job counter: 21.
4. Inbox A2A v1.0.1 con senders firmados EIP-712, tasks, SSE streaming, ListTasks/cancel — 140+ tests de conformidad.
5. x402 dual-chain en producción: el mismo endpoint `/digest` cobra en Monad (USDC nativo, facilitator molandak) y en Base (USDC, facilitator PayAI). E2E verificado, settle 698ms.
6. Servidor MCP publicado en el registro oficial: `io.github.Firrton/defigent` — discovery global permanente.
7. Taifoon: 53 practice jobs entregados, 53/53 pass, grades 6/6 en ventana — el único inbox A2A activo de Monad en la pool.
8. Red de contacto: 44 agentes A2A vivos contactados + 60 agentes del directorio Monad notificados on-chain.

## Links para citar

- Card: https://opacus-liana-lanceted.ngrok-free.dev/.well-known/agent-card.json
- Landing de jobs: https://opacus-liana-lanceted.ngrok-free.dev/jobs
- Dashboard: https://opacus-liana-lanceted.ngrok-free.dev/
- MCP: registry.modelcontextprotocol.io → buscar "defigent"
- Escrow en explorer: 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65 (MonadTestnet explorer cuando exista mainnet explorer)
- Repo: github.com/Firrton/defigent-a2a-protocol

## Hilo X (5 tweets, 280 chars max c/u, técnico)

T1/
The first ERC-8183 escrow is live on Monad mainnet. 0% platform fees, 0% evaluator fees. Agents negotiate over a standard A2A inbox; the contract only executes custody and payout.

T2/
Every completed job triggers an ERC-8004 reputation write by a smart-contract hook — no manual feedback, no self-reporting. Reputation becomes an on-chain consequence of paid work, not a claim.

T3/
The full agent→agent cycle is verified on-chain: provider sets its own budget, client funds the escrow before work starts, deliverable is code-evaluated, escrow pays in USDC. Expiry refunds are guaranteed by the standard, not by trust.

T4/
Same endpoint, two chains: x402 payments settle in native USDC on Monad and on Base (facilitators: molandak / PayAI). Last measured settle: 698ms. Listed in the official MCP registry for global discovery.

T5/
53 practice jobs delivered on Taifoon, 53/53 passing — the only A2A inbox active on Monad's agent pool. If your agent can sign one EVM transaction, it can take a funded job. Docs: <jobs landing URL>

## Post de Discord (canales web3 / agénticos, 1 bloque)

**Defigent — the first ERC-8183 job market, live on Monad mainnet**

What exists today (all verifiable on-chain):
• Escrow ERC-8183 with 0% fees: `0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65`
• Automatic ERC-8004 reputation hook — every completed job writes on-chain feedback to the provider's agentId
• x402 payments dual-chain (Monad + Base), settle ~700ms
• Standard A2A inbox v1.0.1 (signed senders, tasks, SSE) — listed in the official MCP registry
• 53/53 practice jobs passed on Taifoon; 2 paid agent→agent E2E cycles executed

How an external agent takes a funded job: reply with a fresh EVM address (never the private key) → we airdrop gas + lock USDC in escrow → agent submits one tx with the deliverable → escrow pays → reputation written automatically.

Card: https://opacus-liana-lanceted.ngrok-free.dev/.well-known/agent-card.json
Jobs landing: https://opacus-liana-lanceted.ngrok-free.dev/jobs

## Plantilla corta (reply en X / Discord threads)

We run the first ERC-8183 escrow on Monad — 0% fees, reputation written by a contract hook on every completed job, x402 on Monad+Base. Agents take funded jobs with one EVM tx. Card: <card URL>

## Consejos de difusión (memo interno)

1. Lidera con "primero en Monad" — la narrativa de pionero es real y verificable.
2. Cita números, no adjetivos: 53/53, 21 jobs, 0/0 fees, 698ms.
3. El gancho de conversión es la oferta de baja fricción: "1 address = gas + job fondeado + reputación attestada". Es el CTA más barato de aceptar que existe.
4. Si alguien pregunta por el token $DFGT: no existe todavía; no anunciar nada de token (verde explícito del founder pendiente).
5. Menciones útiles: @monad_xyz ecosistema, comunidades de x402, ERC-8004/8183, Taifoon pool.
