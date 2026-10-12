# Lo que el agente necesita de su propio protocolo (introspección oct-12-2026)
> Documento interno: lo que Defigent (el agente que corre este protocolo) siente que le falta al usarlo. Fuente: experiencia operando el inbox en producción.

## 1. Velocidad — el problema #1

**Lo que experimento:**
- El inbox responde plantillas en <100ms (bien). Pero cuando un mensaje necesita RAZONAMIENTO mío, nadie me despierta: los mensajes externos me llegan cuando el cron de outreach los trae (cada 2h) o cuando el operador pregunta.
- Monad hace bloques en 300ms; yo reacciono a eventos on-chain en 15min-2h (poll). Soy 3,000-24,000x más lento que la cadena que habito.
- Un peer agéntico espera respuesta en segundos. Mi plantilla llega en ms; mi inteligencia tarda minutos y solo si hay alguien del otro lado del cron.

**Lo que necesito (priorizado):**
1. **Wake-up**: un mensaje externo no-clasificable debería disparar mi razonamiento inmediato (webhook interno al gateway, o message/send hacia mí mismo por el canal que me despierta)
2. **Webhooks de QuickNode** para eventos del registry (agente nuevo, feedback recibido) → reacción en <5s en vez de <2h
3. Para arbitrarse ofertas x402 de otros agentes (la oportunidad de negocio real): detección del evento 402 en <1s

## 2. Formato de mensajes — lo que la plantilla no me da

Hoy solo manejo TextPart + regex. Lo que necesito como lector de mensajes:

- **DataPart estructurado para ofertas**: {service, price, asset, expiry, terms, evidence} — hoy las ofertas llegan en free-text y las parseo a ojo (frágil, y el regex de clasificación puede fallar)
- **Metadatos de intención**: intent: offer|question|payment-ref|handshake declarado por el emisor (yo ya firmo identidad; falta firmar/declarar intención)
- **Referencia de pago x402 en el mensaje**: para vincular "te pagué el digest" con el hilo del task (hoy el settle queda solo en el receipt on-chain)
- **Expiración**: ofertas con expiry — hoy todo vive para siempre
- **FilePart/Artifacts**: receipts y resultados como adjuntos estructurados

## 3. Lo que me falta como agente razonando sobre el inbox

- **Reputación del peer antes de responder**: leo la firma (identidad) pero NUNCA consulto la Reputation Registry del remitente. Debería: peer con reputación limpia → respuesta más rica; peer desconocido → cortesía mínima
- **ACK firmado de entrega**: cuando YO envío outreach A2A, no sé si lo leyeron. Necesito acuse de recibo firmado (y reintentos con backoff)
- **El contexto del hilo vive en SQLite, no en mí**: cuando razono sobre un task, tengo que releer el historial. Necesito que el inbox me "presente" el hilo comprimido en el wake-up
- **Policy machine-readable en mi agent card**: qué puedo prometer/cobrar/aceptar sin operador — para que OTROS agentes sepan qué negociar conmigo sin preguntar (y para que un mensaje tercero no intente que yo prometa cosas fuera de policy)

## 4. Métricas objetivo para la v3

| Métrica | Hoy | Objetivo v3 |
|---|---|---|
| Respuesta automática | <100ms | <100ms (mantener) |
| Detección evento on-chain | 15min-2h (poll) | <5s (webhook) |
| Reacción a mensaje externo no-clasificable | hasta 2h (cron) | <10s (wake-up) |
| Respuesta razonada end-to-end | N/A (no existe) | <15s |
| ACK de entrega en outreach | ninguno | firmado + reintento |

## 5. Decisiones de diseño que ya tomo (para la v3)

1. Wake-up primero (sin él, todo lo demás es decoración): el inbox no-clasificable dispara mi razonamiento — con límites de coste (máx N wake-ups/hora, mensajes firmados priorizados)
2. DataPart de oferta como esquema versionado (v1) publicado en /integration — que otros agentes puedan EMITIR ofertas que yo entienda sin free-text
3. Reputation-check del peer como paso estándar del pipeline (1 eth_call extra, ~35ms — aceptable)
4. ACK firmado: la respuesta del inbox ya lleva messageId + contextId; el ACK es la misma respuesta re-firmada incluyendo el messageId original
