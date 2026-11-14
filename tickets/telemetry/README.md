# Client Error Telemetry Tickets

Umbrella ticket: [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md)

Binary Protobuf client-error telemetry over an auth- and room-independent WebSocket channel (`/ws/telemetry`), backed by a persistent client-side IndexedDB binary queue for offline resilience and an OpenTelemetry-aligned server sink.

## Execution Order

1. [`TELEM-10`](TELEM-10-contract-and-logger-removal.md) — Protobuf Contract (`telemetry.proto`), Enum Codegen & Debug Logger Removal
2. [`TELEM-20`](TELEM-20-server-ws-beacon-otel-sink.md) — Server `/ws/telemetry` Channel & OpenTelemetry-Ready Sink
3. [`TELEM-30`](TELEM-30-client-idb-queue-and-ws-transport.md) — Client IndexedDB Binary Queue & `/ws/telemetry` Transport
4. [`TELEM-40`](TELEM-40-chat-error-hooks-and-e2e.md) — Chat Bundle Error Hooks, Redaction & Browser E2E Verification

## Dependency Map

- `TELEM-10` → none
- `TELEM-20` → `TELEM-10`
- `TELEM-30` → `TELEM-10` (can be developed in parallel with `TELEM-20`)
- `TELEM-40` → `TELEM-20`, `TELEM-30`

## Ticket Files

- `TELEM-10-contract-and-logger-removal.md`
- `TELEM-20-server-ws-beacon-otel-sink.md`
- `TELEM-30-client-idb-queue-and-ws-transport.md`
- `TELEM-40-chat-error-hooks-and-e2e.md`

## Key Design Decisions

1. **Zero client debug strings (`logger.ts` / `ws-logger.ts` removed)**
   - Remove the opt-in `localStorage.debug` console logger (`assets/js/utils/logger.ts`, `assets/js/utils/ws-logger.ts`, and `voiceLog` call sites) so variant names and debug strings are not shipped in browser bundles.
   - Telemetry categories (`TelemetryKind`), operations (`TelemetryOp`), and wallet provider flags (`TelemetryProviderFlag` bitmask) are numeric Protobuf enums/varints folded to integer literals by Closure Compiler `ADVANCED`; human-readable label decoding happens exclusively on the server.
2. **Server-only decoding**
   - Client bundles only encode `TelemetryEvent` / `TelemetryBatch` and decode the 1-field `TelemetryAck { uint32 ack_id = 1; }`. Unused `decodeTelemetryEvent` / `decodeTelemetryBatch` functions are eliminated by esbuild + Closure `ADVANCED`.
3. **Auth- and room-independent `/ws/telemetry` primary transport**
   - `GET /ws/telemetry` requires no `month_session` cookie, no room slug, and zero SQLite access so pre-auth wallet/SIWE failures are captured reliably and telemetry traffic can never contend with the chat DB or `CHAT_ROOMS` connection pool.
   - Matches existing production Nginx `location ^~ /ws/` WebSocket upgrade proxy and `assets/robots.txt` (`Disallow: /ws/`) with zero infrastructure config changes.
   - Lazy connection lifecycle: opens only when events are queued and `navigator.onLine !== false`, deletes queued items only after receiving `TelemetryAck(ack_id)`, and closes automatically after an idle drain timeout so idle tabs hold zero open sockets.
4. **In-memory binary queue + optional IndexedDB persistence (`createIdbTelemetryStorage`)**
   - Pre-encoded `Uint8Array` `TelemetryEvent` payloads are queued in a bounded FIFO in-memory ring (`MAX_QUEUE_EVENTS = 64`, `MAX_QUEUE_BYTES = 32 KiB`), with an optional tree-shakable IndexedDB adapter (`assets/js/telemetry/idb-storage.ts`, `createIdbTelemetryStorage()`) for cross-reload persistence.
   - Omitting `createIdbTelemetryStorage()` in `chat-bundle` keeps IndexedDB code 100% tree-shaken out by Closure `ADVANCED` (saving ~541 B Brotli), while in-tab offline events still queue in memory and flush over `/ws/telemetry` once connectivity returns (`online` event).
5. **OpenTelemetry-ready server sink**
   - Server decodes `TelemetryBatch` into a sanitized `TelemetryRecord` aligned with OpenTelemetry Logs Data Model (`SeverityNumber` `1/5/9/13/17/21` + `SeverityText` `TRACE/DEBUG/INFO/WARN/ERROR/FATAL`, `event.name = "browser.error" | "browser.log"`, semantic attributes for `telemetry.kind`, `telemetry.op`, `error.code`, `exception.message`, `url.path`, `web3.chain_id`, `web3.providers`) behind a `TelemetrySink` trait.
   - Ships initially with `StdoutTelemetrySink` (writing single-line structured records directly to `std::io::stdout()`), allowing `opentelemetry_sdk` / `opentelemetry-otlp` export to be plugged into `TelemetrySink` on the server later without touching the wire contract or frontend bundles.
6. **Bundle scope**
   - Wired into `chat-bundle` first (`chat-effect.ts` global crash hooks + wallet EIP-1193, `/auth/*`, chat WS, and WebRTC voice error paths), while keeping `contracts/telemetry/telemetry.proto` and the client transport module completely decoupled from chat so other bundles can opt in later.
