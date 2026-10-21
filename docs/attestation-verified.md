# Attestation ERC-8183 → ERC-8004 VERIFICADA on-chain (14-oct)

Ciclo completo en Monad mainnet con identity real del provider:

- jobId 5: create(provider=B, evaluator=A, hook=DefigentReputationHook) → setBudget(0.01 USDC) → fund → submit → complete — TODO status 0x1
- Al `complete`, el hook (0x03d516e52fd64e2d19a817498f941d7dea452cd6) llamó giveFeedback automáticamente:
  - agentId 10407 (provider B, registrado en el Identity Registry de Monad)
  - client del feedback = la dirección del HOOK (0x03d516e5…, no un humano)
  - valor 10, tags [erc-8183-job, escrow-settled]
- Verificación: readAllFeedback(10407) del Reputation Registry 0x8004BAa1…9b63

Significado: la reputación ERC-8004 ahora se gana completando jobs con escrow —
no se puede escribir sin un settle on-chain real. El gating por reputación
(ReputationGateHook) es el siguiente paso natural.

Self-test antecedente: jobId 4 (ciclo completo con provider sin agentId → el hook
correctamente NO escribió nada — guard de providerAgentId==0 verificado).
docs: broadcast 60/60 verificado (landing /jobs live, dedupe+retry)
