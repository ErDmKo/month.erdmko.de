---
title: "Forward Frontend Runtime and Wallet Errors to Server Logs"
ticket: "DEPLOY-30"
status: "in_progress"
draft: false
weight: 30
---

# DEPLOY-30 Forward Frontend Runtime and Wallet Errors to Server Logs

**Priority: P2. Observability and production debugging (umbrella ticket).**

## Sub-Tickets (Execution Breakdown)

See the [Telemetry backlog](../telemetry/README.md) for the full execution order and dependency map:

1. [TELEM-10](../telemetry/TELEM-10-contract-and-logger-removal.md) — Telemetry Protobuf Contract, Enum Codegen & Debug Logger Removal
2. [TELEM-20](../telemetry/TELEM-20-server-ws-beacon-otel-sink.md) — Server `/ws/telemetry` Channel & OpenTelemetry-Ready Sink
3. [TELEM-30](../telemetry/TELEM-30-client-idb-queue-and-ws-transport.md) — Client IndexedDB Binary Queue & `/ws/telemetry` Transport
4. [TELEM-40](../telemetry/TELEM-40-chat-error-hooks-and-e2e.md) — Chat Bundle Error Hooks, Redaction & Browser E2E Verification

## Goal

Surface client-side wallet RPC failures, SIWE/payment errors, WebSocket/WebRTC errors, and uncaught browser exceptions in structured, OpenTelemetry-ready server logs — with zero debug string bloat in browser bundles and persistent offline queuing on the client.

## Evidence

While debugging Phantom wallet sign-in (`code: -32000`, `"The app's signature request cannot be shown as the address does not match the provided address for verification"`), the server logs only showed `POST /auth/nonce 200` with no visibility into the subsequent client-side `personal_sign` rejection or provider metadata (`isPhantom`, `isMetaMask`, `chainId`).

## Architecture Summary

- **Remove client console debug logger (`logger.ts`, `ws-logger.ts`, `voiceLog`)**: Strip `localStorage.debug` hooks and frame-name string tables from client bundles.
- **Standalone Protobuf contract (`contracts/telemetry/telemetry.proto`) & server-only decoding**:
  - Represent event categories (`TelemetryKind`), operations (`TelemetryOp`), and wallet provider flags (`TelemetryProviderFlag` bitmask) as numeric Protobuf enums/varints folded to integer literals by Closure Compiler `ADVANCED`.
  - Human-readable enum/bitmask decoding happens exclusively on the Rust server; unused client decode functions are tree-shaken out of `chat-bundle.js`.
- **Client `observer` + `localStorage` binary queue (`TELEM-30`)**:
  - `initTelemetry(ctx, ...): Task<TelemetryObs>` exposes a standard `ObserverInstance<TelemetryInput>` pipeline (`assets/js/CODESTYLE.md`), storing pre-encoded `Uint8Array` `TelemetryEvent` records in a bounded FIFO queue (`64` events) backed synchronously by `ctx.localStorage` (`'chat-telemetry'` hex slices, zero `decodeTelemetryEvent` / `decodeTelemetryBatch` client code) with ACK-gated deletion.
- **Auth- & room-independent `/ws/telemetry` channel (`TELEM-20`, `TELEM-30`)**:
  - Transport is a lazy WebSocket channel `GET /ws/telemetry` (no session cookie, no room dependency, zero SQLite access, isolated connection cap, covered by existing Nginx `location ^~ /ws/`). Server replies with `TelemetryAck { ack_id }` and idle connections close automatically once drained. (`sendBeacon` was intentionally omitted since IndexedDB persists unacknowledged records across reloads/unloads.)
- **OpenTelemetry-ready server sink (`TELEM-20`)**:
  - Server decodes and sanitizes batches into `TelemetryRecord` behind a `TelemetrySink` trait aligned to OpenTelemetry Logs Data Model (`SeverityNumber` `1/5/9/13/17/21` + `SeverityText` `TRACE/DEBUG/INFO/WARN/ERROR/FATAL`, `event.name = "browser.error" | "browser.log"`), writing structured entries directly to `stdout` via `StdoutTelemetrySink` today and ready to swap/fan-out to `opentelemetry_sdk` / `opentelemetry-otlp` on the server later.
- **Bundle coverage (`TELEM-40`)**:
  - Wired into `chat-bundle` initially (`/chat` and `/chat/{room}`), while keeping the wire contract and client telemetry module chat-agnostic for future opt-in by other bundles.

## Open Follow-Up (WIP — Bundle Size Measurements)

- Baseline before `TELEM-10` (`a747f80`): `chat-bundle.js` = `34,386 B` raw / `12,062 B` Brotli-11 (`23,566 B` Brotli across all 5 bundles).
- Removing `logger.ts` / `ws-logger.ts` / `voiceLog` (`TELEM-10`) saved **-546 B Brotli** (`12,062 B` → `11,516 B`) on `chat-bundle.js` (`-868 B` Brotli across all 5 bundles).
- Refactoring telemetry to `CODESTYLE.md` (`ObserverInstance<TelemetryInput>` + `Task` init + shared `extractErrorInfo` + central `incoming` / `chatUiObs` listeners + synchronous `localStorage` Protobuf hex queue instead of `IndexedDB`) brings `chat-bundle.js` **with full cross-reload local persistence enabled** to **`37,545 B` raw / `13,414 B` Brotli-11** (`+1,352 B` on `chat-bundle.js`, or **`+1,030 B` Brotli net across all 5 bundles** — `-1,592 B` raw / `-308 B` Brotli smaller than the previous IndexedDB build).

## Acceptance

- [x] [`TELEM-10`](../telemetry/TELEM-10-contract-and-logger-removal.md): `logger.ts` / `ws-logger.ts` removed; `contracts/telemetry/telemetry.proto` and numeric TS enum codegen working.
- [x] [`TELEM-20`](../telemetry/TELEM-20-server-ws-beacon-otel-sink.md): `GET /ws/telemetry` (with `TelemetryAck`) enforces `Origin`, connection cap, size, and rate limits, scrubs secrets/control chars, and emits OpenTelemetry-aligned records via `TelemetrySink`.
- [x] [`TELEM-30`](../telemetry/TELEM-30-client-idb-queue-and-ws-transport.md): Client binary queue (with optional tree-shakable IndexedDB adapter) retains events offline, flushes over `/ws/telemetry` with ACK-gated deletion, and closes idle sockets.
- [x] [`TELEM-40`](../telemetry/TELEM-40-chat-error-hooks-and-e2e.md): `chat-bundle` reports wallet RPC, auth HTTP, WS, WebRTC, and uncaught errors; unit, Rust, and Puppeteer Page Object E2E suites pass with verified zero debug/enum string bloat.
