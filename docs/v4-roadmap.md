# Defigent A2A Protocol — Roadmap v4 (oct-12-2026)
> Fuente: 3 investigaciones (UIs del ecosistema, spec v1.0.1 gaps, frontera de confianza ERC-8004) + estado del protocolo. Verificado en vivo contra Monad mainnet.

## 1. DASHBOARD v1 (interfaz visual) — máxima prioridad de adopción
**El argumento**: toda la difusión apunta a /network y /integration que hoy son JSON crudo — la primera impresión de operadores (Monsmith, Chord, Mog) y comunidad es un archivo de máquina. Un dashboard convierte la visita en confianza.
**Patrones validados por los exploradores dominantes** (8004scan.io, trust8004.xyz, 8004agents.ai, A2A Inspector oficial):
1. Tiles de stats con deltas (uptime, agentes, inbox, latencia RPC) ← /status
2. Directorio filtrable con pills (hasInbox/x402) ← /network (ESTA es la tabla del "mapa de red" v1; grafo D3 solo en v2 — con ~50 agentes una buena tabla gana)
3. Feed en vivo del inbox con polling 10s — **el diferenciador**: ningún explorador 8004 muestra el flujo real de mensajes de un hub
4. Task explorer: badges de estado + timeline del historial firmado + consola raw JSON + deep-links #/tasks/:id (patrón A2A Inspector)
5. Sub-puntajes nombrados > score único; fórmula pública (QuickNode reputation-v1 como referencia)
**Stack**: vanilla HTML/CSS/JS servido por el mismo Express — sin build tools. Página pública de confianza (no panel admin).

## 2. CONFIANZA on-chain (frontera verificada en vivo hoy)
- **ownerOf(agentId) == sender** tras la firma EIP-712 (selector 0x6352211e, 1 eth_call); fallback getAgentWallet (0x00339509). VERIFICADO: ownerOf(10331)=getAgentWallet(10331)=0x940e…7638 ✓. Caveat: prueba control del NFT hoy, no identidad estable → es un TIER de confianza, no autorización absoluta
- **readAllFeedback(agentId, [], "", "", false)** = todo el feedback en 1 eth_call; getSummary exige clients[] no vacío (anti-Sybil). VERIFICADO en vivo: agente 10330 con 3 feedbacks → getSummary=(3,16,0), con tag1="vouch" → (2,75)
- **Advertencia arXiv**: 73-91% de reviewers son Sybil → la reputación es señal débil con gating (respuesta rica vs cortesía mínima), NO score absoluto
- Caché 5-15 min de consultas de reputación

## 3. CONFORMIDAD spec v1.0.1 (lo que falta, priorizado)
1. **ListTasks** (§3.1.4/§9.4.4): params contextId/status/pageSize(1-100)/pageToken/historyLength/includeArtifacts; respuesta tasks[] + nextPageToken (siempre presente, "" en última) + totalSize; orden DESC por status.timestamp; cursor-based. **Mayor gap de conformidad con menor esfuerzo** — el SDK oficial y el a2a-inspector lo invocan. (~1-2 días; el dashboard lo necesita también → sinergia)
2. **Extended Agent Card** (§3.1.11): segunda card tras el middleware EIP-712 + códigos de error. (~0.5-1 día)
3. **Extensions opt-in**: header A2A-Extensions + message.metadata["uri"]; required:true → error. (~0.5-1 día)
4. **a2aregistry.org**: listar Defigent = POST del wellKnownURI, sin código. (trámite)
5. **Push notifications** (§3.1.7-10): POSTERGAR — solo si hay clientes desconectados reales; el payload reutiliza el formato SSE ya construido
6. **Firmas JWS de card** (§8.4): POSTPONER — RFC 8785 + semántica de defaults proto es frágil, nadie firma en producción, ecosistema decidiendo identidad (issue #1672). Reevaluar cuando a2a-js firme server-side

## 4. POSTERGADOS (con fecha de reevaluación)
- **Validation Registry**: no desplegado en Monad ("coming soon" docs.monad.xyz), spec en revisión con TEE, 0 deployments mainnet conocidos → watch-only
- **Cifrado E2E**: nada estandarizado en A2A ni MCP (TLS + securitySchemes solamente). Vía práctica futura: ECIES con la pubkey recuperada de la firma EIP-712 del peer, o keyAgreement X25519 firmado — como extensión propia defigent:cipher@v1. Última prioridad
- **Grafo de red D3**: dashboard v2 (con volumen >100 agentes)
- **Reputación visual en dashboard**: v2, tras implementar el gating con readAllFeedback

## Orden de ejecución v4
1. ListTasks (JSON-RPC + REST GET /tasks) — conformidad + base del dashboard
2. Dashboard v1 (hero + tiles + directorio + task explorer + guía)
3. ownerOf/getAgentWallet check + readAllFeedback gating (respuestas ricas solo a peers verificados+reputados)
4. Extended Card + extensions opt-in
5. Listado en a2aregistry.org
