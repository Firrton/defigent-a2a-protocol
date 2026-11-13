# Protocolo de jobs tipado v1: diseño

> **Estado:** propuesta para aprobación, sin código escrito.
> **Base:** `origin/main` aa32988, que es lo que corre en producción.
> **Rama:** `feat/typed-inbox`. **Fecha:** 2026-10-23.

## 1. Qué es y por qué

Es una familia chica de mensajes tipados (DataParts de A2A) para dos cosas: las ofertas y el ciclo de vida de un job en el escrow ERC-8183. Con ella, el inbox resuelve esos mensajes con código: valida el mensaje, lee la cadena y responde con el próximo paso exacto. No interviene ningún LLM ni hace falta un operador para entender lo que llega.

Por qué ahora (verificado en `main`):

- **Toda oferta termina en el operador.** `offer`, `offer_structured` y `other` van a la cola del operador (`http_server.mjs:770`). Eso incluye `offer_schema_v1`, que ya es tipado. La respuesta depende de Hermes, con un timeout de 30 minutos.
- **Nadie lee las respuestas a nuestras ofertas.** La campaña pide "una dirección o `NO_WALLET`", o "dirección + número de job", pero esas respuestas caen en `other`. A eso se suma que el script imprime la respuesta síncrona del peer a nuestro `message/send` y la descarta.
- **El servidor no sabe nada del escrow.** Cada paso de un job es un script manual.
- **Resultado:** cero jobs completados por terceros. La fricción está en el medio del flujo, no solo en la entrada.

**Cómo se ve el éxito:** un agente externo pasa de "recibí una oferta" a "cobré" sin que un LLM o una persona tenga que interpretar mensajes. En v1, el operador solo se queda con los pasos que mueven plata, y le llegan como acciones estructuradas en lugar de texto.

## 2. Metas, no-metas y anti-metas

**Metas**

1. Mensajes tipados para tres cosas:
   - ofertas, en los dos sentidos;
   - aceptar o rechazar una oferta;
   - avisar o consultar el estado de un job.
2. Ruteo determinístico: un mensaje tipado no pasa nunca por el clasificador de texto ni por un LLM.
3. La cadena es la fuente de verdad: antes de responder, todo dato de un job se lee con `getJob`.
4. Cada respuesta trae el próximo paso de dos formas: como dato ejecutable (contrato + calldata) y como una línea de texto.
5. Es interoperable: extensión A2A declarada en la card, JSON Schema publicado y las mismas convenciones que AP2 y UCP.
6. Es compatible: `offer_schema_v1` y el camino de texto siguen funcionando igual que hoy.
7. Nada se traba en silencio: un barrido periódico detecta entregas sin aviso y jobs por vencer.

**No-metas (v1)**

- El inbox no firma transacciones ni guarda claves. Crear, fondear, evaluar y reembolsar siguen en manos del operador.
- No hay evaluación de entregables por LLM.
- No cambia el clasificador de texto ni las respuestas de texto que ya existen.
- El inbox no descarga URLs que manden terceros.
- No cubre el digest x402 ni otros servicios que se cobran por HTTP.
- Las ofertas no se firman (ver §10).
- Defigent no actúa como provider: en v1 es siempre cliente y evaluador (ver §6, "Roles en v1").

**Anti-metas (sería un fracaso aunque funcione)**

- Un dialecto que solo habla Defigent, sin esquema publicado.
- Decidir sobre plata según lo que dice un mensaje y no según lo que dice la cadena.
- Meter la clave admin/tesorería en el proceso expuesto a internet.
- Romperles algo a los agentes que hoy hablan en texto.

## 3. Restricciones verificadas

**Runtime y dependencias**

- Producción corre Node ≥ 22, por better-sqlite3 13.
- El código es ESM `.mjs`.
- Ya están instalados `zod` 4.6.5 (validación y export a JSON Schema) y `viem` 2.57.4 (lecturas, ABI, calldata). No hace falta ninguna dependencia nueva.

**Persistencia.** El mismo SQLite (`defigent_a2a.db`, en modo WAL).

**A2A**

- La versión vigente es la 1.0.1.
- Diferencias entre 1.0 y 0.3:

  | | 1.0 | 0.3 |
  |---|---|---|
  | Tipo de una parte | el campo presente: `text`, `raw`, `url` o `data` | campo `kind` |
  | `data` | cualquier valor JSON | tiene que ser un objeto |
  | Estados y roles | `TASK_STATE_*` y `ROLE_*` | en minúscula |
  | Header de extensiones | `A2A-Extensions` | `X-A2A-Extensions` |

- Los bindings de comercio (AP2 v0.1, a2a-x402, UCP) y los ejemplos de registro de ERC-8004 siguen en 0.3. Además, un servidor 1.0 debe tratar un pedido sin `A2A-Version` como 0.3. Hay que hablar los dos formatos.
- Hoy el inbox acepta los dos al entrar, y toma como DataPart cualquier parte con un objeto en `data` (`http_server.mjs:702`).
- Al responder usa una forma híbrida (`kind:"message"` con partes `{type:"text"}`) que no es ni 0.3 ni 1.0.

**Tareas**

- taskId es igual a contextId, y un mensaje nuevo reabre una tarea terminada. En 1.0 una tarea terminal no se reabre. Es deuda que ya existe, y el camino tipado no la empeora.
- Las tareas no tienen dueño y su historial es público: cualquiera puede escribir en cualquier tarea, y `GET /tasks/:id` y el dashboard muestran todo. Lo tipado queda a la vista.

**Escrow (ERC8183, sin meta-transacciones)**

- Secuencia:
  1. `createJob` (cliente).
  2. `setBudget` (solo el provider, `ERC8183.sol:641`).
  3. `fund` (solo el cliente, con token y monto esperados).
  4. `submit` (provider).
  5. `complete` o `reject` (evaluador).
  6. `claimRefund` (cualquiera, una vez vencido).
- Estados: Open, Funded, Submitted, Completed, Rejected, Expired.
- El provider paga gas dos veces.
- **Ventana de evaluación.** Un job Submitted se puede reembolsar al cliente una hora después de `expiredAt` (`EVALUATION_GRACE_PERIOD`). Si evaluamos tarde, el provider pierde el pago de un trabajo que ya entregó.
- Con un claim pendiente, `claimRefund` revierte en los jobs Open o Funded (`PendingClaimExists`).

**Seguridad y tráfico**

- **Identidad.** El EIP-712 actual (`params.auth`) prueba que el emisor controla una dirección, pero no firma el contenido ni guarda nonces.
- **Deduplicación.** Hoy es un `Set` en memoria indexado por `messageId`, y se pierde al reiniciar.
- **Límite de tráfico.** 10 mensajes por minuto por IP, que alcanza para un hilo de job.

**Trabajo en paralelo**

- **Conflicto pendiente.** La rama sin mergear `fix/claims-and-classifier-quick-wins` reescribe el mismo bloque del clasificador, así que hay que integrar en orden.
- **Hook v2** ([PR #5](https://github.com/Firrton/defigent-a2a-protocol/pull/5), sin deployar):
  - `beforeAction` no hace nada salvo exigir que llame el escrow;
  - `afterAction` guarda el entregable en `submit` y atesta en `complete`;
  - no necesita `optParams`, así que `0x` sirve;
  - `complete()` revierte con `InsufficientGas` si el límite de gas es tan bajo que la atestación fallaría en silencio. Con estado frío en Monad necesita unos 610k de gas, así que para `evaluate`, `jobs_actions.mjs` usa la estimación o al menos 700k.

  La dirección del hook sale de la configuración; nunca va escrita en el código. Quitar v1 de la whitelist no afecta a los jobs que ya existen, y el PR lo resuelve retirando v1 en dos fases.

## 4. Principios

1. **Un mensaje avisa, no prueba.** Si alguien dice "ya fondeé el job 42", no se le cree: se lee `getJob(42)`.
2. **La autoridad la da el contrato.** Solo el provider puede llamar `setBudget` o `submit`, y solo el cliente puede llamar `fund`. Para que el dinero esté seguro no hace falta firmar cada mensaje.
3. **Toda respuesta dice qué sigue:** qué hay que hacer, quién lo hace y cómo.
4. **Copiar precedentes antes que inventar:**
   - el tipo va como clave con namespace dentro de `data` (AP2, UCP);
   - la versión mayor va solo en el URI de la extensión (AP2, a2a-x402, AdCP);
   - el estado de ERC-8183 viaja dentro del payload y el estado de la tarea A2A se mapea en grueso (a2a-x402);
   - los avisos se llaman como las transiciones de ERC-8183 y de Virtuals ACP.
5. **El camino tipado se suma al existente.** Un mensaje sin DataPart tipado se procesa igual que hoy.

## 5. Mensajes

### Sobre

Un mensaje tipado lleva exactamente un DataPart, y ese DataPart tiene exactamente una clave de la familia `defigent.job.*`. El valor de la clave es el contenido. En 1.0 se ve así:

```json
{ "data": { "defigent.job.accept": { "offerId": "of_7Hq2kd9xTa", "party": { "address": "0xAbC…", "agentId": 10270 } } } }
```

En 0.3 es igual, con `"kind": "data"` agregado.

- **Texto.** Los TextParts son solo orientativos: si hay un DataPart tipado, el inbox no clasifica el texto.
- **Extensión.** El mensaje lista el URI de la extensión en `extensions`.
- **Convenciones de formato:**
  - los montos van en unidades base y como string (`"250000"` son 0.25 USDC);
  - las direcciones van con checksum;
  - los tiempos van en segundos Unix;
  - el `chainId` siempre es explícito.
- **Identificadores:**
  - quien emite una oferta genera su `offerId` (`of_` seguido de 10 caracteres `[A-Za-z0-9]`);
  - `jobId` es el id del escrow, expresado como string.

### Claves

| Clave | Quién la manda | Para qué |
|---|---|---|
| `defigent.job.offer` | cliente o provider | Propone un job: qué, cuánto, dónde se liquida y hasta cuándo |
| `defigent.job.accept` | la contraparte | Acepta una oferta con su dirección y su agentId |
| `defigent.job.decline` | la contraparte | Rechaza una oferta con un motivo |
| `defigent.job.created`, `budget_set`, `funded`, `submitted`, `completed`, `rejected`, `expired` | la parte que hizo la transición | Avisan una transición on-chain: `{jobId, txHash?}`, y `submitted` suma `deliverable` |
| `defigent.job.query` | cualquiera | Pregunta "¿en qué está y qué sigue?" sobre un `offerId` o un `jobId` |
| `defigent.job.status` | quien responde | Estado de la oferta y/o del job, más `next` |
| `defigent.job.error` | quien rechaza | `{code, message, field?, retryable}` |

Los avisos de transición son pistas. El inbox lee la cadena y responde según lo que encuentra ahí, no según lo que dice el aviso. Por eso los siete avisos y `query` comparten un solo handler. Todo pedido tipado válido recibe un `status` o un `error`.

### Ejemplos

Oferta de Defigent a un provider (paga Defigent). `side` indica qué rol toma quien emite la oferta: `client` paga y `provider` trabaja.

```json
{ "data": { "defigent.job.offer": {
  "offerId": "of_7Hq2kd9xTa",
  "side": "client",
  "service": "a2a-conformance-probe",
  "description": "Answer tasks/get for a random id with JSON-RPC error -32001 and return the raw response.",
  "price": { "amount": "250000", "token": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "decimals": 6, "symbol": "USDC" },
  "settlement": { "chainId": 143, "escrow": "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65" },
  "deliverable": { "mediaType": "application/json", "acceptance": "operator" },
  "providerSteps": ["setBudget", "submit"],
  "gas": { "providerTxs": 2, "grant": null },
  "to": { "agentId": 10270 },
  "replyTo": { "url": "https://<inbox>/inbox", "contextId": "of_7Hq2kd9xTa" },
  "expiresAt": 1792800000
} } }
```

Aviso de entrega:

```json
{ "data": { "defigent.job.submitted": { "jobId": "42", "txHash": "0x…", "deliverable": { "hash": "0x…", "uri": "https://…", "mediaType": "application/json" } } } }
```

Respuesta de estado:

```json
{ "data": { "defigent.job.status": {
  "offer": { "offerId": "of_7Hq2kd9xTa", "state": "accepted" },
  "job": {
    "jobId": "42",
    "chainStatus": "Open",
    "client": "0x940e…7638",
    "provider": "0xAbC…",
    "evaluator": "0x940e…7638",
    "budget": { "amount": "0", "token": null },
    "expiresAt": 1792800000,
    "block": "48211903"
  },
  "next": {
    "actor": "provider",
    "to": "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65",
    "function": "setBudget(uint256,address,uint256,bytes)",
    "args": ["42", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "250000", "0x"],
    "data": "0x…",
    "note": "Set the agreed budget. Defigent funds the escrow right after."
  }
} } }
```

Error:

```json
{ "data": { "defigent.job.error": { "code": "offer_expired", "field": "offerId", "message": "Offer of_7Hq2kd9xTa expired at 1792800000.", "retryable": false } } }
```

Códigos de error de negocio en v1: `unknown_offer`, `offer_expired`, `offer_taken`, `identity_mismatch`, `job_not_found`, `state_mismatch`, `idempotency_conflict`, `unsupported_key`.

### El job on-chain apunta a la oferta

Al crear el job, `createJob` guarda en `description` un JSON canónico (claves ordenadas, sin espacios) que tiene versión propia:

```json
{"offerId":"of_7Hq2kd9xTa","terms":"0x<keccak256 de la oferta canónica>","v":1}
```

Así cualquiera puede verificar que el job corresponde a esos términos. El precedente es el `JobDescription` del SDK ERC-8183 de BNB Chain. Por su parte, `deliverable.hash` es el bytes32 que el provider manda en `submit`; en v1, el keccak256 del contenido.

### Compatibilidad con `offer_schema_v1`

Un mensaje `{intent:"offer", service, price, asset?, expiry?, terms?, evidence?}` se convierte en un `defigent.job.offer` con `side: "provider"`, porque quien escribe ofrece hacer el trabajo. La conversión de campos es así:

- `price` pasa de decimal a unidades base según el token de `asset` (USDC por defecto).
- `expiry`, que viene en milisegundos, pasa a `expiresAt` en segundos.
- `terms` pasa a `description`.

La respuesta pasa a ser tipada, y el artifact `received-offer` se mantiene.

## 6. Manejo determinístico

Cada mensaje entrante se procesa en este orden:

1. **Detección.** El mensaje va por el camino tipado si un DataPart trae una clave `defigent.job.*` o la forma legacy. Esto se decide antes de crear o tocar la tarea.
2. **Validación** contra el esquema. Si falla, el inbox responde con JSON-RPC `-32602` y un `ErrorInfo`, donde `domain` es el URI de la extensión y `metadata.field` el campo afectado. No se crea ninguna tarea. Un mensaje con más de una clave tipada también es `-32602`.
3. **Clave natural.** El handler busca por `offerId` o `jobId`, no por `contextId`. Responde en el `contextId` que usó el peer y guarda la relación entre los dos.
4. **Lecturas on-chain** con timeout: `getJob`, `ownerOf`/`getAgentWallet` y tokens permitidos. Si la RPC falla, el inbox responde con JSON-RPC `-32603` y un `ErrorInfo` `CHAIN_UNAVAILABLE` (se puede reintentar), y no cambia ningún estado.
5. **Handlers puros.** Hay uno para `offer`, otro para `accept` y `decline`, y uno solo para los avisos de transición y `query`: lee la cadena y arma el `status` con `next`. Cada handler recibe el mensaje, el estado guardado y las lecturas, y devuelve la respuesta, el estado de la tarea y las acciones. No hacen I/O, así que se pueden testear sin levantar el servidor.
6. **Idempotencia persistente.** Funciona en dos niveles:
   - el par (remitente, `messageId`) se guarda en SQLite;
   - por clave natural: la misma clave con el mismo contenido devuelve la misma respuesta, y la misma clave con contenido distinto da `idempotency_conflict`.
7. **Acciones estructuradas** para lo que mueve plata. Cada una es una línea en la wake queue con:
   - `action`: `review_offer`, `create_job`, `fund`, `evaluate`, `refund` o `gas_grant`;
   - los datos exactos de la operación;
   - una clave de idempotencia.

   El operador las ejecuta con un script, sin interpretar texto (ver "Cómo se cierra el ciclo").
8. **Respuesta.** Una tarea con la forma estándar de la versión del pedido, que lleva en `status.message` el `status` o `error` tipado más una línea de texto. El inbox devuelve además el header de extensión activada.

Reglas por clave:

| Entra | Condición | Responde | Acción |
|---|---|---|---|
| `offer` de cualquier lado | válida, token permitido, no vencida | `status`, oferta `under_review` | `review_offer` |
| `accept` de una oferta nuestra | la oferta existe, no venció y está libre; `party.address` es owner o agentWallet de `party.agentId`; si la oferta tenía `to`, coincide | `status`, oferta `accepted`, y qué sigue | `create_job` |
| `accept` | la oferta venció, ya está tomada o la identidad no coincide | `error` | — |
| `decline` de una oferta nuestra | — | `status`, oferta `declined` | — |
| aviso de transición o `query` | el job existe en nuestro escrow | `status` con `next` | si el próximo paso es nuestro: `fund`, `evaluate` o `refund` |
| `status` o `error` que nos mandan | — | nada; solo se registra | — |
| clave desconocida de la familia | — | `error` `unsupported_key` | — |

Estado de la tarea A2A (el estado de ERC-8183 viaja dentro del payload):

| Situación | Estado |
|---|---|
| Nos toca a nosotros: oferta en revisión, crear el job, fondear o evaluar el entregable | `working` |
| Le toca a la contraparte: responder nuestra oferta, fijar el budget o hacer submit | `input-required` |
| El job quedó Completed on-chain, o la contraparte rechazó nuestra oferta | `completed` |
| Rechazamos la oferta o el mensaje por una regla de negocio | `rejected` |
| El evaluador rechazó el entregable o el job venció | `failed` |

### Roles en v1

Defigent es siempre cliente y evaluador. Es lo que pide la prioridad de hoy: que un tercero complete un job y cobre.

- Las ofertas entrantes, vengan del lado que vengan, van a revisión (`review_offer`). El veredicto del operador vuelve como un `accept` o un `decline` tipado (ver abajo).
- Si Defigent termina siendo provider en algún job, el inbox solo responde `status` y no genera acciones. Ese caso necesita otra máquina de estados y otro evaluador (el contrato revierte con `ProviderCannotBeEvaluator`), y queda para más adelante.

### Cómo se cierra el ciclo

- **Ejecución de acciones.** `scripts/jobs_actions.mjs` lista las acciones pendientes y ejecuta una por vez, cuando el operador la aprueba. Usa la clave que el operador ya tiene y simula cada transacción antes de mandarla. En la fase 2, el mismo script corre solo, con su propia wallet y con topes.
- **Resultado de vuelta.** Cada resultado vuelve por el outbox que ya existe, de una de dos formas:
  - como un aviso tipado (`defigent.job.created`, `funded`, `completed` o `rejected`);
  - como el `accept` o `decline` de una revisión.

  Lleva la clave de idempotencia de la acción en `replyId`. El inbox lo verifica con `getJob` antes de guardarlo, porque un mensaje avisa y no prueba, aunque venga de nuestro propio operador. Chequea tres cosas: que el cliente seamos nosotros, que el provider sea la dirección aceptada y que `description` apunte a la oferta.
- **Cómo se entera el peer.**
  - **Por consulta, siempre.** Su tarea cambia de estado, y `status.message` trae el `status` con `next`. Lo ve con `tasks/get` o mandando un `query`.
  - **Por aviso, cuando se puede.** El script le manda el aviso tipado a su endpoint. Ese endpoint sale del ledger (es el mismo al que le mandamos la oferta) o, para las ofertas entrantes, de su registración ERC-8004 on-chain. El inbox, que está expuesto a internet, nunca hace requests a URLs que llegan en mensajes.

### Barrido periódico

Hay casos en los que nadie nos manda nada: un peer que llama `submit` sin avisar, o un job que vence. Para cubrirlos, el inbox recorre cada N segundos los jobs no terminados del ledger, igual que hoy recorre los timeouts del operador. Lee `getJob`, `pendingClaimHash` y la hora del bloque, y genera acciones sin duplicarlas:

| Encuentra | Acción |
|---|---|
| Budget igual al acordado, sin fondear | `fund` |
| Submitted | `evaluate`, con el límite `expiredAt + 1 h` |
| Submitted y cerca de ese límite | `evaluate` urgente, para que el provider no pierda el pago |
| Vencido sin entrega y sin claim pendiente | `refund` |

Solo lee jobs del ledger, con un tope de lecturas por vuelta. Para dejar margen de evaluación, las ofertas usan vencimientos de al menos 24 horas.

## 7. El próximo paso según el estado del job

| Estado on-chain | Próximo paso | Actor |
|---|---|---|
| Oferta aceptada, todavía sin job | crear el job; la contraparte recibe `defigent.job.created` | Defigent, vía la acción `create_job` |
| Open, sin budget | `setBudget(jobId, token, monto acordado, 0x)` | provider |
| Open, budget distinto del acordado | `error` `state_mismatch` y volver a llamar `setBudget` con el monto correcto | provider |
| Open, budget igual al acordado | `approve` del token y `fund(jobId, token, budget, 0x)` | Defigent, vía la acción `fund` |
| Funded | `submit(jobId, keccak256(entregable), 0x)` | provider |
| Submitted | `complete` o `reject` | Defigent, vía la acción `evaluate` |
| Completed o Rejected | nada; se informa lo liquidado | — |
| Vencido sin terminar | `claimRefund(jobId)` | Defigent, vía la acción `refund` |

`next.data` lleva el calldata ya codificado: un agente con wallet lo puede firmar y enviar sin conocer el ABI. Antes de devolverlo, el inbox lo simula con un `eth_call` desde la dirección del actor y agrega `next.simulation`, con `ok` o con el motivo del revert. Así el provider no gasta gas en una transacción que va a fallar.

## 8. Ofertas salientes y respuestas en texto

- **Ledger de ofertas** en SQLite, con offerId, peer, términos, estado, vencimiento y jobId. Sin este registro no hay forma de validar un `accept`.
- **Script `send_offer` en JS**, que usa el mismo módulo:
  1. manda el DataPart y el texto, con el URI de la extensión en `extensions`;
  2. registra la oferta;
  3. pasa por el mismo handler la respuesta síncrona del peer, que hoy se descarta.
- **Adaptador para respuestas en texto.** Hace falta porque la mayoría de los peers son LLMs que contestan en texto. Funciona con regex, sin LLM:
  - Si un mensaje de texto trae un `offerId` nuestro y exactamente una dirección `0x`, se trata como `accept`.
  - Si trae `NO_WALLET`, se trata como `decline`.
  - El agentId sale del `to` de la oferta. Si la oferta no estaba dirigida a nadie, el texto tiene que incluir `agentId N`.
  - Si el mensaje no encaja exacto, va al operador como hoy.

## 9. Extensión, card y documentación

- **Extensión.** Se declara en `capabilities.extensions`:

  ```json
  {
    "uri": "https://w3id.org/defigent/a2a/erc8183-jobs/v1",
    "description": "Typed ERC-8183 job offers and lifecycle messages as A2A DataParts.",
    "required": false,
    "params": { "chainId": 143, "escrow": "0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65", "tokens": ["0x754704Bc059F8C67012fEd69BC8A327a5aafb603"], "schema": "<url del JSON Schema>" }
  }
  ```

- **`required: false`.** Con `true`, los SDKs 1.0 cortarían a los clientes genéricos con `-32008`, y hoy casi nadie habla esta extensión.
- **URI.** Es un identificador permanente. w3id.org, que es lo que sugiere la spec de A2A, redirige a donde esté publicada la spec, y ese destino puede cambiar sin romper el URI.
  - Registrar el redirect requiere mandar un PR público a w3id.org, y eso lo tenés que hacer vos.
  - Mientras tanto, el URI funciona igual como identificador.
- **Versionado.** Dentro de v1 solo hay cambios aditivos. Un cambio incompatible lleva un URI nuevo (`/v2`) y no hay fallback entre versiones.
- **Headers.**
  - El inbox acepta `A2A-Extensions` (1.0) y `X-A2A-Extensions` (0.3) y devuelve las extensiones activadas.
  - Las claves tipadas se procesan aunque el cliente no mande el header.
- **Extensión de identidad.** La que ya existe también se declara en `capabilities.extensions`. El array `extensions` que hoy está en el nivel superior se mantiene por compatibilidad.
- **Publicación:**
  - `GET /schemas/erc8183-jobs-v1.json` sirve el JSON Schema, generado desde los mismos esquemas zod que usa el inbox para validar, así que hay una sola fuente de verdad;
  - la spec legible se publica en `/a2a/ext/erc8183-jobs/v1`.
- **Documentación.**
  - `/integration` suma una sección con los ejemplos de arriba, y `offer_schema_v1` queda documentado como legacy compatible.
  - `docs/operator-outbox.md` documenta el formato de las acciones.

## 10. Seguridad

- **Sin claves en el inbox.** Todo lo que mueve plata sale como acción.
- **Identidad en `accept`.** `party.address` tiene que ser owner o agentWallet de `party.agentId`. Es la misma regla del hook v2, así la reputación cae en el agente correcto. Con esta regla, aceptar en nombre de otro solo crea un job para la dirección real de ese otro, así que no le sirve a nadie.
- **Ofertas sin firma en v1.** La autenticidad la da la cadena: el job lo crea la dirección de Defigent, y el provider puede verificarlo antes de gastar gas. Las cotizaciones firmadas (con el precedente del SDK de BNB) quedan para v2.
- **Topes configurables:** monto máximo por oferta, ofertas abiertas por agente y acciones `create_job` por día.
- **Historial público.** Los términos de las ofertas quedan visibles, igual que en la cadena. Ningún mensaje tipado lleva datos secretos.
- **Datos no confiables.** Todo lo que llega por la extensión se trata como dato no confiable. `deliverable.uri` se guarda pero no se descarga, para evitar SSRF.
- **Sin requests a URLs que llegan en mensajes.** Los avisos salientes no los manda nunca el inbox: los manda el script del operador, al endpoint del ledger o al de la registración on-chain.
- **Idempotencia persistente** para todo lo tipado. El `Set` en memoria sigue para el resto.

## 11. Fases

- **Fase 1 (este diseño):**
  - extensión, esquemas y ruteo tipado;
  - lecturas on-chain, `next` con calldata y simulación;
  - ledger de ofertas, `send_offer` y adaptador de texto;
  - acciones estructuradas, `jobs_actions.mjs` con aprobación del operador y vuelta por el outbox;
  - barrido periódico;
  - card, esquema publicado e `/integration`;
  - tests.
- **Fase 2 (depende de tu decisión, que no hace falta tomar ahora):**
  - `jobs_actions.mjs` corriendo solo, con una wallet de jobs propia (no la admin) y topes por job y por día;
  - evaluación automática de los entregables que se pueden verificar por hash.

  Recién ahí el flujo funciona sin personas de punta a punta.

## 12. Decisiones

**Tuyas (pendientes, para la fase 2)**

- Si `jobs_actions.mjs` corre solo, con wallet propia y topes, o si el operador sigue aprobando cada acción.

**Mías (revisables)**

- **Alcance:** en v1 Defigent es siempre cliente y evaluador, y las ofertas entrantes van a revisión.
- **Ciclo:**
  - los resultados vuelven por el outbox y se verifican on-chain;
  - el peer se entera siempre por consulta, y por aviso cuando se puede;
  - los avisos los manda el script del operador, nunca el inbox.
- **Barrido periódico** para entregas sin aviso y jobs vencidos.
- **Simulación** de cada `next` antes de devolverlo.
- **Formato de los mensajes:**
  - El tipo es una clave con namespace dentro de `data`, con un único DataPart tipado por mensaje (AP2, UCP).
  - Los avisos usan los nombres de las transiciones de ERC-8183 y ACP, y un solo handler los atiende a todos.
- **Extensión:** URI en w3id.org con la versión mayor en la ruta, y `required: false`.
- **Errores:** un error de esquema devuelve `-32602` y no crea tarea; una regla de negocio deja la tarea `rejected` y devuelve un `error`.
- **Esquemas:** zod es la única fuente, y el JSON Schema se genera a partir de él.
- **Identidad y negociación:**
  - `accept` exige un agentId con vínculo on-chain.
  - Las ofertas no se firman en v1.
- **On-chain:** `job.description` guarda un JSON versionado que apunta a la oferta.
- **Lo existente:** las respuestas de texto que ya hay no cambian.

## 13. Lo que queda para quien construya

Queda abierto:

- la estructura de archivos y los nombres;
- la definición exacta de los esquemas;
- las tablas de SQLite;
- los textos de las respuestas;
- los valores de los topes;
- la serialización exacta de cada versión de A2A;
- la estructura de los tests: handlers puros con un lector de cadena falso, más un par de tests de punta a punta en `a2a_inbox.test.mjs`.

## 14. Pasos que no son código

- **Hermes.** Hay que enseñarle a leer las líneas de acción y a llamar `jobs_actions.mjs`. Su configuración vive fuera del repo.
- **w3id.org.** Hay que registrar el redirect del URI de la extensión con un PR público.
- **Hook v2.** Conviene deployarlo antes del primer job tipado con un tercero, para que la primera reputación externa no se pueda farmear.
- **Orden de merge.** Hay que definir qué entra primero: esta rama o `fix/claims-and-classifier-quick-wins`.

## 15. Referencias

- A2A, spec y extensiones: https://a2a-protocol.org/latest/specification/ · https://a2a-protocol.org/latest/topics/extensions/ · https://github.com/a2aproject/A2A/blob/main/docs/whats-new-v1.md
- AP2 v0.1 sobre A2A: https://raw.githubusercontent.com/google-agentic-commerce/AP2/v0.1.0/docs/a2a-extension.md
- UCP sobre A2A: https://ucp.dev/specification/shopping/checkout/a2a/
- a2a-x402 v0.2: https://raw.githubusercontent.com/google-agentic-commerce/a2a-x402/main/spec/v0.2/spec.md
- ERC-8183: https://eips.ethereum.org/EIPS/eip-8183
- SDK ERC-8183 de BNB Chain: https://raw.githubusercontent.com/bnb-chain/bnbagent-sdk/main/python/bnbagent/erc8183/schema.py
- AdCP sobre A2A (perfil con DataParts y errores): https://docs.adcontextprotocol.org/dist/docs/3.2.0-rc.1/building/by-layer/L0/a2a-guide
