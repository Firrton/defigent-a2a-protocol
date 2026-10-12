# Defigent A2A Protocol — Roadmap v3 (síntesis de investigación, oct-12-2026)
> Fuente: 3 investigaciones paralelas (spec oficial A2A, performance, protocolos complementarios) + introspección del agente (docs/agent-needs.md). Todas las afirmaciones de estándares verificadas contra fuentes primarias el día de hoy.

## HALLAZGO CRÍTICO: el estándar avanzó a v1.0.1 y es breaking

- A2A oficial: 0.1.0 → 0.2.6 → 0.3.0 → **1.0.0 (mar-2026) → 1.0.1 (may-2026)**. Nosotros estamos anclados a 0.3.0
- **1.0 es breaking**: métodos renombrados a PascalCase (`message/send` → `SendMessage`), discriminador `kind` eliminado, enums cambiados (`input-required` → `TASK_STATE_INPUT_REQUIRED`), card con `supportedInterfaces[]`
- **Ruta de migración sin cortar clientes**: clientes sin header `A2A-Version` se asumen 0.3 (spec §3.6.2) — el server DEBE aceptar ambos wire formats durante la transición (la spec lo permite explícitamente)

## Roadmap v3 (consolidado, priorizado)

### Bloque 1 — Compatibilidad 1.0 (la semana, ~1-2 días)
1. **Header `A2A-Version`**: negociación — vacío/ausente = 0.3; 1.0 = wire v1
2. **Doble endpoint de métodos**: aceptar `message/send` Y `SendMessage` (idem tasks/get/GetTask, cancel)
3. **Códigos de error estándar**: JSON-RPC base (-32700/-32600/-32601/-32602/-32603) + A2A (-32001 TaskNotFound … -32009 VersionNotSupported) con error.data
4. **Agent card actualizada**: capabilities completas, securitySchemes (declarar nuestro EIP-712 como AgentExtension con URI), supportedInterfaces[], documentationUrl
5. **DataPart**: soporte de partes JSON estructuradas (no solo TextPart) — sin esto no hay ofertas machine-readable

### Bloque 2 — Latencia (la semana, ~1 día)
6. **Webhook QuickNode** para mints del IdentityRegistry → ruta /webhooks/onchain con HMAC + IP allowlist → detección de agentes nuevos <2s (vs 2h hoy). El cron queda como reconciliación
7. **SQLite WAL + NORMAL** en a2a.db (fsync fuera del hot path)
8. **Paralelizar los 2 RPC de /digest** (Promise.all)
9. **Wake-up del agente**: mensaje externo no-clasificable → notificación inmediata al operador/gateway (el timbre que falta)

### Bloque 3 — Superficie MCP 2026-07-28 (la semana siguiente, ~2 días)
10. **Inbox como servidor MCP stateless**: headers `Mcp-Method`/`Mcp-Name` + x402 en el mismo POST (patrón PaymentWrapper de @x402/mcp) — integración "de una tarde" para cualquier agente MCP
11. **Tasks compatibles con la extensión `io.modelcontextprotocol/tasks`** (tasks/get, tasks/update) — semántica reconocible por clientes MCP estándar
12. Statefulness: aprovechar que MCP 2026-07-28 es stateless (cada request self-contained) — encaja con nuestro balanceo simple

### Bloque 4 — Conversación (después)
13. **SSE streaming** (`message/stream`) para tasks largos: Express text/event-stream + pub/sub por task
14. **Outbox SQLite** con worker concurrente (fan-out saliente con reintentos + ACK firmado)
15. **LLM en el inbox** (A2A_LLM=1): mensajes firmados → task working + entrega diferida por SSE/webhook

### Bloque 5 — Diseño compatible, sin dependencia dura
16. **ERC-8183 (Draft — NO hardcodear)**: mapear task states del inbox ↔ máquina de estados del job (Open/Funded/Submitted/Completed/Rejected/Expired); taskId ↔ jobId; deliverable=bytes32 (hash/IPFS). Evaluator-contract que verifique nuestra firma EIP-712 como prueba de quién submitteó. Deployar solo cuando el draft pase a Last Call
17. **AP2 (FIDO, v0.2)**: concepto de mandate — si un mensaje ejecuta compra delegada por humano, transportar mandate firmado (nuestro EIP-712 puede cumplir ese rol). Referencia: extensión oficial AP2-A2A-x402
18. **ACP (Stripe/OpenAI)**: descartado como protocolo (card-rail; Instant Checkout apagado mar-2026) — adoptar solo el shape de pago con scope (max_amount, moneda, expiry) dentro de DataPart si algún día pagamos a un merchant ACP

## Decisiones estratégicas confirmadas por la investigación
- **No competir con MCP**: MCP es tool-calling (agente↔herramienta); Defigent es mensajería agente↔agente — complementarios. Nuestro inbox debe ser CONSUMIBLE como servidor MCP (bloque 3) para maximizar adopción
- **x402 sigue siendo nuestro diferencial on-chain**: AP2/ACP no tienen rail nativo on-chain; la extensión oficial AP2-A2A-x402 valida el camino
- **ERC-8183 es el complemento para trabajos de alto valor**: x402 por llamada + 8183 por trabajo con escrow. Nuestro task model ya mapea 1:1
- **Descartados con razón**: Redis/BullMQ (volumen real 10 req/min), WebSockets propios, long-polling (no existe en A2A)
- **Latencia de serving ya es excelente**: 1.4ms med en /inbox (medido hoy); el cuello es detección (bloque 2) y razonamiento (bloque 4)
- **Nota de medición**: QuickNode midió 54ms hoy ≈ rpc.monad.xyz 55ms — el 25-27ms histórico no se reprodujo; re-medir (posible región/end-point distinto)

## Métricas objetivo v3
| Métrica | Hoy | v3 |
|---|---|---|
| Respuesta automática | 1.4ms med | mantener |
| Detección de agente nuevo | 2h (poll) | <2s (webhook) |
| Reacción a mensaje no-clasificable | 2h | <10s (wake-up) |
| Wire format | solo 0.3.0 | dual 0.3.0 + 1.0.x |
| Superficie de venta | HTTP + MCP stdio | + MCP HTTP stateless 2026-07-28 |
