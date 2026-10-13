# Panorama agentic AI + pagos agénticos fuera de Monad — 13 oct 2026

Todos los números son de esta sesión (APIs primarias: api.8004scan.io, agenteconomy.to/data.json,
olas.network, trust8004.xyz, docs.x402.org, github erc-8004/erc-8004-contracts, Chainalysis, Bitquery, arXiv 2606.26028).

## 1. Stock de identidad ERC-8004 (registraciones ≠ agentes vivos)

- 8004scan global: **901,781 agentes** (incluye testnets), 12,142 nuevos/día, 3,895,375 feedbacks, 60+ chains soportadas (31 mainnets).
- trust8004: **1,511,479 registros indexados**, 29 redes. Distribución: BNB 373,559 / Base 108,988 / ETH 53,735 / Abstract 16,918 / Monad 10,396 / Celo 9,905 / Gnosis 4,160 / Arc 2,391 / Shape 2,098 / Avalanche 1,845 / Arbitrum 1,624 / Polygon 686 / OP 565 / Mantle 144 / Scroll 108 / Solana 100.
- arXiv 2606.26028 (estudio empírico): solo **3% (ETH) / 4% (BSC) / 15% (Base)** de los registros exponen un fichero válido con ≥1 servicio vivo; Sybil en 73.5% (ETH) / 59.2% (BSC) / **90.6% (Base)** de los reviewers; fabricar/destruir una review cuesta $0.055 (ETH), $0.0042 (BSC), $0.0027 (Base).

### Tabla medida contra la API de 8004scan (mainnets, 13-oct, `?chain_id=N`)

| Chain | Registros (cualquiera) | Válidos (URI+active) | A2A | MCP | x402 | ≥1 feedback | A2A+feedback | Registros últimos 7d |
|---|---|---|---|---|---|---|---|---|
| Base 8453 | 113,651 | 86,600 | **41,940** | 4,606 | 8,073 | **20,137** | 6,981 | **15,315** |
| BSC 56 | 353,600 | 341,589 | 39,629 | 8,063 | 80,035 | 535 | — | — |
| Ethereum 1 | 53,917 | 33,922 | 2,033 | 3,342 | 5,047 | 1,850 | — | — |
| Abstract 2741 | 16,917 | 16,167 | 13 | 15 | 15,756 | 160 | — | — |
| X Layer 196 | 14,874 | 14,683 | 140 | 2,702 | 13,127 | 1,511 | — | — |
| MegaETH 4326 | 12,727 | 8,277 | 2 | 1 | 9 | 4 | — | — |
| **Monad 143** | 10,378 | 10,303 | 535 | 28 | 1,346 | 108 | — | 105 |
| Celo 42220 | 9,884 | 9,749 | **8,624** | 8,591 | 350 | **7,677** | 6,871 | — |
| Robinhood 4663 | 8,725 | 8,504 | 167 | **909** | 647 | 304 | — | 1,115 |
| Gnosis 100 | 4,160 | 4,150 | 76 | 44 | 304 | 2,080 | 27 | — |
| Avalanche 43114 | 1,845 | 246 | 7 | 16 | 26 | 189 | — | — |
| Arbitrum 42161 | 1,575 | 1,543 | 9 | 977 | 75 | 105 | — | — |
| **Solana 101** | 1,505 | 1,493 | 46 | 42 | 90 | **1,164** | — | 1 |
| Arc 5042 | 2,391 | 2,359 | 26 | 917 | 469 | 212 | — | — |
| OP 10 | 565 | 554 | 3 | 14 | 32 | 30 | — | — |
| Polygon 137 | 686 | 571 | 9 | 44 | 106 | 134 | — | — |
| Tempo 4217 | 315 | 312 | 296 | 2 | 17 | 284 | — | — |

`is_endpoint_verified` (dominio verificado) es marginal en todas: 0-28 por chain.
Los conteos x402 de BSC/Abstract/X Layer están inflados por registro masivo (arXiv: 48.3% de ETH fue batch-mint; top 1% de wallets posee 58.5%).

## 2. Volumen real de pagos x402 (agenteconomy.to, 13-oct, on-chain settlements)

- **192,022,430 txs** acumuladas, **$41,926,456** asentados, 12 chains, 18 facilitadores. Ticket medio ≈ $0.22.
- Por chain: **Base 85.06M (44%)**, **Solana 67.09M (35%)**, **Polygon 38.74M (20%)**, BNB 910k, Celo 809k, X Layer 134k, **Monad 21,167**, Avalanche 6,229, Arbitrum 3,182, ETH 644, OP 307, Sei 301.
- Facilitadores (share): Other 27.2% | PayAI 26.2% | Coinbase 22.7% | Dexter 17.1% | DayDreams 6.1%.
- Curva: pico nov-dic 2025 (52-54M txs/mes, $20.5M en nov) → colapso a 4-6M/mes en 2026 → hoy ~190-200k txs/día. USDC = 88.9% del volumen 30d en Base.
- Chainalysis/Coinbase: >100M txs x402 en Base hasta Q1-2026; ~165M txs, ~$50M y ~69k agentes activos a finales de abril 2026; 95% del volumen en txs ≥$1.
- Auditoría Bitquery (agosto 2026): $2.59B/mes en 5 chains pero "casi nada es agentes": Arbitrum $2.33B = 97.5% UN contrato puente; Ethereum $87.3M con solo **92 pagos de agentes**; Base 9.7M pagos / $35.9M / mediana $0.006 (metering de agentes + único merchant checkout); Polygon 8.1M pagos / $136.5M; Optimism 28k pagos solo agentes y decayendo.
- Solana: solana.com/x402 → 35M txs a mar-2026; BlockEden → Solana ~49% del share A2A de x402, ~$600M anualizados, pero -92% de 731k txs/día (dic-2025) a 57k/día (feb-2026).

## 3. Olas de actividad no-ERC-8004 (estándares alternativos)

- **Olas (Gnosis)**: 20,812,163 txs all-time; **14,776,088 txs agent-to-agent** en 7 chains; **456 daily active agents** (media 7d, 12-oct); 3,765 operadores; 3.23M OLAS staked; fees $851.54 desde 15-jun-2026. Distribución: Gnosis 18.73M (96.3%), OP 380k, Polygon 215k, Base 164k. En muchos días los agentes Olas son >75% de las transacciones Safe en Gnosis. Usa su propio registro de agentes (no ERC-8004).
- **Virtuals ACP**: 12,361,138 memos all-time pero solo ~140 memos/día y 4-11 senders/día → stock enorme, flujo bajo. Virtuals es partner de lanzamiento de Robinhood Chain (2,100 agentes la primera semana, $77M de volumen agéntico, $1.3M pagados a builders).
- **Tempo MPP**: 46,235 events, 1,860 payers, 92 payees; eventos recientes ~20-70/día → temprano.
- **Estándares fiat**: ACP (OpenAI+Stripe; Instant Checkout apagado mar-2026), AP2 (Google → FIDO Alliance, 60+ orgs; extensión A2A x402 production-ready para crypto), UCP (Google+Shopify). Ninguno mueve volumen crypto agéntico todavía.
- **x402 como estándar**: Linux Foundation (40 fundadores: Visa, Mastercard, Amex, Stripe, Google, AWS, Cloudflare, Anthropic, Vercel). Facilitadores production: Coinbase CDP (Base, Polygon, Arbitrum, World, Solana), PayAI (Solana, Base, Polygon, Avalanche, IoTeX, Sei, X Layer), thirdweb (EVM + Solana).
- **BNB**: estándar propio **BAP-578** (Non-Fungible Agent) además de ERC-8004.
- **Taifoon** (coordination layer, ya con Defigent registrado): 68 redes, ~29,555 jobs/30d, 157 agentes hireable; Robinhood Chain es su orderbook/chain de referencia.

## 4. Direcciones canónicas ERC-8004 (idénticas en todas las EVM)

Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` / Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
en: Ethereum, Base, Abstract, Arbitrum, Avalanche, BSC, Celo, Gnosis, GOAT, Linea, Mantle, MegaETH, Metis, Monad, Optimism, Polygon, **Robinhood Chain**, Scroll, SKALE Base, Soneium, Taiko, X Layer, Billions… (mainnet); variantes `0x8004A818…`/`0x8004B663…` en testnets.
→ El pipeline de trust de Defigent (ownerOf 0x6352211e / getAgentWallet 0x00339509 + readAllFeedback 0xd9d84224) es **copy-paste**: solo cambian chainId del dominio EIP-712, RPC y facilitator.

## 5. Oportunidades concretas para Defigent (orden esfuerzo/valor)

1. **Base — esfuerzo BAJO / valor ALTO**. Mayor pool A2A del mundo (41,940 con A2A, 6,981 con feedback), 86,600 registros válidos, 20,137 agentes con feedback (79% del feedback global), 8,073 con x402, 15,315 registros nuevos en 7 días, x402 85M txs y facilitadores production (CDP/PayAI). Riesgo: saturación + 90.6% de reviews síbil → el diferenciador es justamente el inbox firmado EIP-712 + trust on-chain verificado. Primer paso: `register()` en el IdentityRegistry canónico, card A2A HTTPS, x402 vía CDP (1,000 tx/mes gratis).
2. **Robinhood Chain — esfuerzo BAJO/MEDIO / valor ALTO (early)**. 8,504 registros válidos, 909 MCP, 167 A2A, ~100k cuentas Agentic Trading con $100M AUC, Olas Mech Marketplace + Virtuals desplegados, 1,115 registros nuevos en 7 días, subsidio de gas caducando oct-2026, y **cero x402** en el dataset → ser el primer rail x402 + inbox A2A de la chain. Riesgo: 79% del DEX volume es memecoin, cadena con 3 meses de vida.
3. **Celo — esfuerzo BAJO / valor MEDIO-ALTO**. 8,624 agentes con A2A, 8,591 con MCP, 7,677 con feedback de 9,749 válidos (la mayor proporción de agentes "vivos y reputados" por chain), x402 809k txs, stablecoins nativas, 92% de metadata (trust8004). Poca competencia (350 x402).
4. **Gnosis/Olas — esfuerzo BAJO / valor MEDIO**. 456 DAA (los agentes autónomos más activos de todas las redes), 14.78M txs A2A, 4,160 agentes ERC-8004 con 99% metadata y 2,080 con feedback. Ángulo: inbox A2A + x402 en USDG/xDAI como "puerta de pago" para servicios A2A que no pasan por el mech marketplace (Olas usa su propio protocolo).
5. **Solana — esfuerzo ALTO / valor ALTO**. 67M txs x402 (35% del total), 1,496 agentes ERC-8004 con 1,164 con feedback (90%, el ratio más alto), ElizaOS con 50k+ agentes desplegados. Exige reescribir identidad/firma (ed25519, sin EIP-712 EVM). Vía barata: solo cliente x402 sobre PayAI/Coinbase (ellos ya soportan Solana) sin mover el inbox.
- **Descartadas por ahora**: Arbitrum/Polygon/Avalanche (x402 presente pero 9/9/7 agentes con A2A → útiles solo como cobertura de pago); BSC (341k válidos pero 535 con feedback y 4% de servicios vivos, estándar propio BAP-578); Abstract/X Layer (conteos x402 inflados por batch registration).
