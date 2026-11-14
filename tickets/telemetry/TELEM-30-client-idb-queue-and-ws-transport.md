---
title: "Client localStorage Base64 Binary Queue & POST /telemetry Transport"
ticket: "TELEM-30"
status: "completed"
draft: false
weight: 30
---

# TELEM-30 Client `localStorage` Base64 Binary Queue & `POST /telemetry` Transport

**Priority: P2. Offline-capable frontend telemetry engine for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- [`TELEM-10`](TELEM-10-contract-and-logger-removal.md)

## Goal

Build a tiny, generic, `CODESTYLE.md`-compliant client telemetry module (`@month/telemetry`) that persists pre-encoded `Uint8Array` `TelemetryEvent` slices in `localStorage` across reloads/offline periods and flushes them via `POST /telemetry` (`keepalive: true`) with zero client-side Protobuf decoders.

## Implemented Scope

1. **Strict `assets/js/CODESTYLE.md` compliance & generic boundary**
   - `TelemetryState` is a 4-slot `TupleOf` (`[queue, inFlight, retryAttempt, retryTimer]`) operated on by top-level functions (`initTelemetry(ctx: Window)`, `recordTelemetry`, `flushTelemetry`) and lazy `Task<T>` combinators.
   - Zero crypto/chat concepts in `@month/telemetry`; zero `decodeTelemetry*` imports so all Protobuf telemetry decoders are tree-shaken out by esbuild + Closure `ADVANCED`.
2. **Bounded `localStorage` Base64 queue (`assets/js/telemetry/queue.ts`)**
   - Stores up to `MAX_QUEUE_EVENTS = 64` pre-encoded `Uint8Array` `TelemetryEvent` slices, framed directly into `TelemetryBatch` (`MAX_BATCH_EVENTS = 10`) via `encodeBytesField`.
   - Synchronously mirrors queued slices to `ctx.localStorage` (`'telemetry'`) using `ctx.btoa` / `ctx.atob` Base64, falling back cleanly to memory if storage throws.
3. **Stateless `POST /telemetry` transport (`assets/js/telemetry/transport.ts`)**
   - Sends `POST /telemetry` (`Content-Type: application/x-protobuf`, `credentials: 'same-origin'`, `keepalive: true`), purging sent slices on `204` and scheduling bounded backoff (`1s → 2s → 5s → 15s`) on network/`429`/`5xx` failures or `online` recovery.

## Implementation Areas

- `assets/js/telemetry/{index.ts,error.ts,queue.ts,transport.ts,telemetry.test.ts}`
- `assets/js/BUILD.bazel` and `assets/js/tsconfig.json`

## Tests and Acceptance

- [x] Clean page load with empty `localStorage` sends zero `fetch` requests.
- [x] Offline events persist in `localStorage` (`'telemetry'`) across simulated reloads, survive network/`503` failures with exponential backoff, and purge cleanly on `204 No Content`.
- [x] Queue cap (`64` events) evicts oldest entries; restricted/throwing `localStorage` falls back cleanly to in-memory queuing.
- [x] `bazel test //assets/js:all` passes under `happy-dom` (`createTestWindow`).
