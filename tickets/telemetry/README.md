# Client Error Telemetry Tickets

Umbrella ticket: [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md) (**Completed**)

Binary Protobuf client-error telemetry over stateless `POST /telemetry` (`keepalive: true`), backed by a synchronous `localStorage` Base64 binary queue on the client, server-side deduplication, and an OpenTelemetry-aligned `stdout` sink.

## Execution Order

1. [`TELEM-10`](TELEM-10-contract-and-logger-removal.md) — Protobuf Contract (`telemetry.proto`), Enum Codegen & Debug Logger Removal (**Completed**)
2. [`TELEM-20`](TELEM-20-server-ws-beacon-otel-sink.md) — Stateless `POST /telemetry` Endpoint, Server Deduplication & OpenTelemetry Sink (**Completed**)
3. [`TELEM-30`](TELEM-30-client-idb-queue-and-ws-transport.md) — Client `localStorage` Base64 Binary Queue & `POST /telemetry` Transport (**Completed**)
4. [`TELEM-40`](TELEM-40-chat-error-hooks-and-e2e.md) — Chat Bundle Error Hooks, Redaction & Browser E2E Verification (**Completed**)

## Key Design Decisions

1. **Zero client debug strings (`logger.ts` / `ws-logger.ts` removed)**
   - Removed the opt-in `localStorage.debug` console logger (`assets/js/utils/logger.ts`, `assets/js/utils/ws-logger.ts`, and `voiceLog` call sites) so variant names and debug strings are excluded from browser bundles.
   - Telemetry severities, categories (`TelemetryKind`), operations (`TelemetryOp`), and wallet provider flags (`TelemetryProviderFlag` bitmask) are numeric Protobuf enums/varints folded to integer literals by Closure Compiler `ADVANCED`; human-readable label decoding happens exclusively on the Rust server.
2. **Zero client Protobuf decoders & stateless `POST /telemetry`**
   - Replaced `/ws/telemetry` + `TelemetryAck` with stateless `POST /telemetry` (`204 No Content`, `keepalive: true`). HTTP status serves directly as batch acknowledgment, removing socket state machines, idle timers, and `TelemetryAck` decoders from client bundles (`-322 B` Brotli) while surviving page navigation natively.
3. **Synchronous `localStorage` (`btoa`/`atob`) binary queue**
   - Pre-encoded `Uint8Array` `TelemetryEvent` slices are queued in a bounded FIFO array (`MAX_QUEUE_EVENTS = 64`) mirrored synchronously to `ctx.localStorage` (`'telemetry'`) via native `ctx.btoa` / `ctx.atob` Base64, avoiding asynchronous `IndexedDB` transaction bloat and unload races.
4. **Server-side deduplication**
   - `TelemetryState::should_emit` deduplicates bursts within a `5s` window keyed by `(client_ip, kind, op, code, message)` after sanitization, removing `dedup.ts` from client bundles while deduplicating across tabs and raw HTTP clients.
5. **OpenTelemetry-aligned `StdoutTelemetrySink`**
   - Decodes `TelemetryBatch` into sanitized `TelemetryRecord` entries (`severity=TRACE|DEBUG|INFO|WARN|ERROR|FATAL`, `event=browser.error|browser.log`) behind `TelemetrySink`, writing single-line structured records directly to `stdout`.
6. **Generic `@month/telemetry` vs `chat` boundary**
   - `initTelemetry(ctx: Window)` uses a 4-slot `TelemetryState` `TupleOf` with zero chat/wallet dependencies; `assets/js/chat/telemetry.ts` wires `initChatTelemetry = once(initTelemetry)` and enriches events with `detectProviderFlags` and `chainId`.
