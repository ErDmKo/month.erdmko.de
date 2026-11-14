---
title: "Forward Frontend Runtime and Wallet Errors to Server Logs"
ticket: "DEPLOY-30"
status: "completed"
draft: false
weight: 30
---

# DEPLOY-30 Forward Frontend Runtime and Wallet Errors to Server Logs

**Priority: P2. Observability and production debugging (umbrella ticket).**

## Sub-Tickets (Execution Breakdown)

See the [Telemetry backlog](../telemetry/README.md) for the full execution order and dependency map:

1. [TELEM-10](../telemetry/TELEM-10-contract-and-logger-removal.md) — Telemetry Protobuf Contract, Enum Codegen & Debug Logger Removal (**Completed**)
2. [TELEM-20](../telemetry/TELEM-20-server-ws-beacon-otel-sink.md) — Stateless `POST /telemetry` Endpoint, Server Deduplication & OpenTelemetry Sink (**Completed**)
3. [TELEM-30](../telemetry/TELEM-30-client-idb-queue-and-ws-transport.md) — Client `localStorage` Base64 Binary Queue & `POST /telemetry` Transport (**Completed**)
4. [TELEM-40](../telemetry/TELEM-40-chat-error-hooks-and-e2e.md) — Chat Bundle Error Hooks, Redaction & Browser E2E Verification (**Completed**)

## Goal

Surface client-side wallet RPC failures, SIWE/payment errors, WebSocket/WebRTC errors, and uncaught browser exceptions in structured, OpenTelemetry-ready server logs — with minimal Brotli bundle overhead, zero debug string bloat in browser bundles, and persistent cross-reload queuing on the client.

## Evidence

While debugging Phantom wallet sign-in (`code: -32000`, `"The app's signature request cannot be shown as the address does not match the provided address for verification"`), the server logs only showed `POST /auth/nonce 200` with no visibility into the subsequent client-side `personal_sign` rejection or provider metadata (`isPhantom`, `isMetaMask`, `chainId`).

## Final Architecture

- **Removed client console debug logger (`logger.ts`, `ws-logger.ts`, `voiceLog`)**: Stripped `localStorage.debug` hooks and frame-name string tables from client bundles.
- **Standalone Protobuf contract (`contracts/telemetry/telemetry.proto`) & server-only decoding**:
  - Event severities (`TelemetrySeverity` OpenTelemetry `1/5/9/13/17/21`), categories (`TelemetryKind`), operations (`TelemetryOp`), and wallet provider flags (`TelemetryProviderFlag` bitmask) are numeric Protobuf enums/varints folded to integer literals by Closure Compiler `ADVANCED`.
  - Human-readable enum/bitmask decoding and secret scrubbing happen exclusively on the Rust server; zero Protobuf telemetry decoders ship in `chat-bundle.js`.
- **Generic `@month/telemetry` state tuple + `localStorage` Base64 queue (`TELEM-30`)**:
  - `initTelemetry(ctx: Window): TelemetryState` manages a 4-slot `TupleOf` (`[queue, inFlight, retryAttempt, retryTimer]`) with pure top-level functions (`assets/js/CODESTYLE.md`), storing pre-encoded `Uint8Array` `TelemetryEvent` slices in a bounded FIFO queue (`64` events) mirrored synchronously to `ctx.localStorage` (`'telemetry'`) via `ctx.btoa` / `ctx.atob`.
- **Stateless `POST /telemetry` (`keepalive: true`, `204 No Content`) & server deduplication (`TELEM-20`)**:
  - Client batches up to `10` events per `POST /telemetry` (`Content-Type: application/x-protobuf`, `keepalive: true`), purging acknowledged slices on `204` and backing off on network/`429`/`5xx` errors.
  - `server/src/telemetry/http.rs` is stateless, auth-independent, room-independent, and SQLite-free, enforcing `Origin`, a `16 KiB` streaming size cap, a `16`-event batch cap, per-IP sliding-window rate limiting (`429`), and a `5s` server-side deduplication window (`TelemetryState::should_emit`).
- **OpenTelemetry-aligned server sink (`TELEM-20`)**:
  - `StdoutTelemetrySink` (behind `TelemetrySink`) writes structured records (`severity=TRACE|DEBUG|INFO|WARN|ERROR|FATAL`) directly to `stdout` for `docker logs my_app | grep telemetry` and future OTLP fan-out.
- **Clean generic/chat boundary (`TELEM-40`)**:
  - `@month/telemetry` has zero crypto/chat knowledge; `assets/js/chat/telemetry.ts` composes `initChatTelemetry = once(initTelemetry)` and enriches chat events with `detectProviderFlags` and `chainId`.

## Bundle Size Results (Brotli-11)

- Pre-`TELEM-10` baseline (`a747f80`): `chat-bundle.js` = `34,386 B` raw / `12,062 B` Brotli-11; all 5 bundles = `23,566 B` Brotli-11.
- Final (`4c5a536`): `chat-bundle.js` = **`35,697 B` raw / `12,585 B` Brotli-11** (`+523 B` / `+4.34%`); all 5 bundles = **`62,338 B` raw / `23,635 B` Brotli-11** (**`+69 B` / `+0.29%` net** across all 5 bundles).

## Acceptance

- [x] [`TELEM-10`](../telemetry/TELEM-10-contract-and-logger-removal.md): `logger.ts` / `ws-logger.ts` removed; `contracts/telemetry/telemetry.proto` and numeric TS enum codegen working.
- [x] [`TELEM-20`](../telemetry/TELEM-20-server-ws-beacon-otel-sink.md): `POST /telemetry` enforces `Origin`, streaming size, batch, rate-limit, and server-side deduplication guards, scrubs secrets/control chars, and emits OpenTelemetry-aligned records (`severity=ERROR`, etc.) via `StdoutTelemetrySink`.
- [x] [`TELEM-30`](../telemetry/TELEM-30-client-idb-queue-and-ws-transport.md): Generic 4-slot `TelemetryState` + `localStorage` (`btoa`/`atob`) binary queue persists events offline/across reloads and flushes via `POST /telemetry` (`keepalive: true`).
- [x] [`TELEM-40`](../telemetry/TELEM-40-chat-error-hooks-and-e2e.md): `chat-bundle` reports wallet RPC, auth HTTP, WS, WebRTC, and uncaught errors; verified in Bazel unit/Rust suites, Puppeteer Page Object E2E suites, and live desktop/mobile Phantom production logs on `erdmko.dev`.
