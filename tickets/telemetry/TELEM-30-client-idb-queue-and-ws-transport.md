---
title: "Client IndexedDB Binary Queue, /ws/telemetry Transport & Last-Resort Beacon"
ticket: "TELEM-30"
status: "planned"
draft: false
weight: 30
---

# TELEM-30 Client IndexedDB Binary Queue, `/ws/telemetry` Transport & Last-Resort Beacon

**Priority: P2. Offline-capable frontend telemetry engine for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- [`TELEM-10`](TELEM-10-contract-and-logger-removal.md)

## Goal

Build a small, dependency-free, codestyle-compliant client telemetry module that persists raw `Uint8Array` `TelemetryEvent` payloads in IndexedDB while offline, flushes them primarily over `/ws/telemetry` with server `TelemetryAck` confirmation, and uses `navigator.sendBeacon('/telemetry')` strictly as a last-resort unload fallback.

## Scope

### 1. Strict adherence to `assets/js/CODESTYLE.md` & zero client decode bloat
- Access all browser APIs via explicit `ctx: Window` (`ctx.indexedDB`, `ctx.WebSocket`, `ctx.navigator`, `ctx.Date`, `ctx.location`, `ctx.setTimeout`, `ctx.clearTimeout`).
- Represent all module state via named-index tuples (`TupleOf` / `ReadonlyTupleOf`), pure top-level functions, `objectStruct` + `validate` capability checks, `bindArg` / `bindArgs`, and lazy `Task<T>` pipelines (no classes, no `async`/`await`, no nested `.then`).
- Never import `decodeTelemetryEvent` or `decodeTelemetryBatch` in client code so esbuild + Closure Compiler `ADVANCED` tree-shakes them completely out of browser bundles; only `encodeTelemetryEvent` and `decodeTelemetryAck` (plus wire-level batch framing) are retained.

### 2. IndexedDB binary queue + synchronized in-memory mirror (`assets/js/telemetry/queue.ts`)
- IndexedDB database `'t'`, version `1`, object store `'q'` (`{ ['autoIncrement']: true }`), storing raw `Uint8Array` `TelemetryEvent` bytes keyed by auto-increment positive integer `id`.
- Synchronized in-memory ring mirror (`Array<ReadonlyTupleOf<{ [ENTRY_ID]: number; [ENTRY_BYTES]: Uint8Array }>>`):
  - Hydrated once on startup from IndexedDB (`getAll` / cursor).
  - Serves as seamless fallback when `ctx.indexedDB` is unavailable or blocked (e.g. strict private browsing / sandboxed iframes).
  - Enables synchronous batch assembly during `pagehide` (where async IndexedDB reads cannot complete before tab teardown).
- **Bounded storage**: cap queue at `MAX_QUEUE_EVENTS = 64` and `MAX_QUEUE_BYTES = 32 * 1024` (32 KiB), evicting oldest entries (`FIFO`) so prolonged offline sessions never grow unbounded.
- **Zero-decode batch assembly**: wrap stored `TelemetryEvent` `Uint8Array` slices directly into `TelemetryBatch` wire format (`field 1 = ack_id = maxEntryId`, repeated `field 2` length-delimited slices up to `<= 12 KiB` / `16` events per frame) without decoding events on the client.

### 3. Deduplication & client rate guard (`assets/js/telemetry/dedup.ts`)
- Suppress duplicate bursts (same `(kind, op, code, message)` fingerprint within a `5_000 ms` window, bounded map of recent fingerprints) so tight error loops or repeated ICE state changes cannot spam IndexedDB or the network.

### 4. Primary `/ws/telemetry` transport (`assets/js/telemetry/transport.ts`)
- **Lazy connection**: do NOT open `/ws/telemetry` on clean page loads when the queue is empty. Open `ws(s)://${ctx.location.host}/ws/telemetry` only when:
  1. Startup hydration discovers pending unacknowledged entries in IndexedDB and `ctx.navigator.onLine !== false`, or
  2. A new `TelemetryEvent` is enqueued while `ctx.navigator.onLine !== false`.
- **ACK-gated deletion**:
  - Send `TelemetryBatch` binary frame (`ws.binaryType = 'arraybuffer'`).
  - Decode incoming binary frame with `decodeTelemetryAck(ctx, bytes)`.
  - Delete entries with `id <= ack[TELEMETRY_ACK_ACK_ID]` from both the in-memory mirror and IndexedDB (`IDBKeyRange.upperBound(ackId)`) **only after** `TelemetryAck` arrives.
  - If more entries remain in the queue, immediately send the next batch.
- **Offline & reconnect handling**:
  - When `ctx.navigator.onLine === false` or the WebSocket closes/errors before `TelemetryAck`, keep unacknowledged entries in IndexedDB and schedule bounded exponential backoff (`1s → 2s → 5s → 15s`, paused while offline).
  - Listen to `ctx.addEventListener('online', ...)` to trigger immediate WebSocket flush when internet connectivity returns.
- **Idle teardown**:
  - Once the queue is completely empty and acknowledged, close `/ws/telemetry` after `10_000 ms` of inactivity so idle tabs consume zero server sockets.

### 5. Last-resort `navigator.sendBeacon` fallback
- Listen to `ctx.addEventListener('pagehide', ...)`.
- **Only** when the page is unloading, unacknowledged entries exist in the in-memory mirror, and `/ws/telemetry` is not open (`readyState !== WebSocket.OPEN` or unable to complete an ACK roundtrip):
  - Assemble up to `16` pending events (`<= 12 KiB`) synchronously from the in-memory mirror into a `TelemetryBatch` `Uint8Array`.
  - Call `ctx.navigator.sendBeacon('/telemetry', batchBytes)`.
  - If `sendBeacon` returns `false` (offline or browser beacon queue full), leave IndexedDB untouched so `/ws/telemetry` flushes them reliably on the next online session. If `sendBeacon` returns `true`, best-effort delete those sent IDs from IndexedDB so they are not re-sent on reload.

## Implementation Areas

- `assets/js/telemetry/{index.ts,queue.ts,dedup.ts,transport.ts}`
- `assets/js/telemetry/telemetry.test.ts`
- `assets/js/BUILD.bazel` and `assets/js/tsconfig.json`

## Tests and Acceptance

- [ ] Enqueuing events while offline (`navigator.onLine === false`) persists raw `Uint8Array` records in IndexedDB without opening a WebSocket or calling `sendBeacon`.
- [ ] Firing `online` (or starting a new session with pre-existing IndexedDB records) opens `/ws/telemetry`, sends `TelemetryBatch`, keeps records if WS drops mid-flight, and deletes records `<= ack_id` only upon receiving `TelemetryAck`.
- [ ] Idle timer closes `/ws/telemetry` once the queue drains and re-opens lazily if a later error occurs.
- [ ] Queue cap (`64` events / `32 KiB`) evicts oldest entries cleanly; missing/throwing `indexedDB` falls back to the in-memory queue without throwing.
- [ ] `sendBeacon('/telemetry', ...)` is never called during normal online operation and fires only on `pagehide` as a last resort when unacknowledged events remain.
- [ ] Duplicate errors within the cooldown window are coalesced.
- [ ] `bazel test //assets/js:all` passes.
