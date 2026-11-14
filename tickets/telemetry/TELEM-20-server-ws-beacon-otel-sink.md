---
title: "Server /ws/telemetry Channel & OpenTelemetry-Ready Sink"
ticket: "TELEM-20"
status: "completed"
draft: false
weight: 20
---

# TELEM-20 Server `/ws/telemetry` Channel & OpenTelemetry-Ready Sink

**Priority: P2. Backend transport and server-only decoding for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- [`TELEM-10`](TELEM-10-contract-and-logger-removal.md)

## Goal

Provide an auth-independent, room-independent, SQLite-free server telemetry ingestion pipeline over WebSocket (`GET /ws/telemetry` with `TelemetryAck` confirmation), decoding compact Protobuf enums/bitmasks on the server into sanitized, OpenTelemetry-aligned records.

> Scope note: `navigator.sendBeacon` / `POST /telemetry` was intentionally skipped for now; persistent IndexedDB queuing on the client (`TELEM-30`) already retains unacknowledged events across reloads/unloads and flushes them over `/ws/telemetry` on the next connection.

## Scope

### 1. OpenTelemetry-aligned `TelemetryRecord` & `TelemetrySink` (`server/src/telemetry/sink.rs`)
Define a clean server-side boundary modeled directly on the OpenTelemetry Logs Data Model so `opentelemetry_sdk` / `opentelemetry-otlp` can replace or wrap the default logger later without touching wire or handler code:

- `TelemetryRecord`:
  - `observed_timestamp_ms: i64` (server `Utc::now().timestamp_millis()`)
  - `client_timestamp_ms: u64` (clamped/validated client timestamp)
  - `severity_number: u8` (`1` = `TRACE`, `5` = `DEBUG`, `9` = `INFO`, `13` = `WARN`, `17` = `ERROR`, `21` = `FATAL`, matching OpenTelemetry Logs Data Model `SeverityNumber`)
  - `severity_text: &'static str` (`"TRACE"`, `"DEBUG"`, `"INFO"`, `"WARN"`, `"ERROR"`, `"FATAL"`)
  - `event_name: &'static str` (`"browser.error"` for `WARN`+, `"browser.log"` for `TRACE`..`INFO`)
  - `kind: &'static str` (decoded on server from `TelemetryKind`: `"uncaught_error"`, `"unhandled_rejection"`, `"wallet_rpc"`, `"auth_http"`, `"ws"`, `"webrtc"`, `"unspecified"`)
  - `op: &'static str` (decoded on server from `TelemetryOp`: `"personal_sign"`, `"eth_sendTransaction"`, `"wallet_switchEthereumChain"`, `"auth_verify"`, etc.)
  - `code: String` (sanitized, max `64` chars)
  - `message: String` (sanitized, max `256` chars)
  - `path: String` (sanitized URL path without query/fragment, max `128` chars)
  - `line: u32`, `column: u32`
  - `chain_id: u64`
  - `providers: String` (decoded list from `provider_flags` bitmask: `"ethereum"`, `"metamask"`, `"phantom"`, `"coinbase"`, `"rabby"`, `"brave"`, or `"none"`)
- `pub trait TelemetrySink: Send + Sync + 'static { fn emit(&self, record: &TelemetryRecord); }`
- Default `StdoutTelemetrySink` (explicitly constructed in `server/src/main.rs`): writes single-line structured key-value records directly to `std::io::stdout()` (`[... {:<5} telemetry] event=... severity=...`) using dynamic `severity_text` (`TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`/`FATAL`) so `docker logs <app> | grep telemetry` and stdout log collectors receive every event without needing `stderr` redirection.

### 2. Server-side sanitization & secret scrubbing (`server/src/telemetry/sanitize.rs`)
- Strip/normalize control characters (`\r`, `\n`, `\t`, `\0`, `0x00..=0x1F`, `0x7F`, Unicode controls) to prevent log injection.
- Strip query strings (`?...`) and fragments (`#...`) from `path`.
- Truncate `code` (`<= 64` chars), `message` (`<= 256` chars), and `path` (`<= 128` chars) on valid UTF-8 char boundaries.
- Scrub accidental secrets from `message`:
  - Hex sequences >= 64 hex digits (both `0x`-prefixed signatures/keys and raw 64-hex session tokens → `[REDACTED_HEX]`, while preserving 40-hex-char wallet addresses).
  - `month_session=...` cookie substrings → `month_session=[REDACTED]`.

### 3. WebSocket channel: `GET /ws/telemetry` (`server/src/telemetry/ws_actor.rs`)
- **Independent of auth and rooms**: does NOT read `month_session`, does NOT require paid access, and does NOT touch SQLite.
- **Reverse-proxy ready**: served under `/ws/telemetry`, covered by production Nginx `location ^~ /ws/` (`Upgrade` + `Connection "upgrade"`) and `robots.txt` (`Disallow: /ws/`).
- **Admission & DoS guards**:
  - Require allowed `Origin` via `is_allowed_origin`.
  - Dedicated atomic connection counter (`MAX_TELEMETRY_CONNECTIONS = 64`) via RAII slot guard, completely separate from `CHAT_ROOMS` (`MAX_OPEN_CONNECTIONS = 100`).
  - Max binary frame size: `MAX_TELEMETRY_PAYLOAD_BYTES = 16 * 1024` (16 KiB).
  - Max events per batch: `1..=16` (`MAX_TELEMETRY_BATCH_EVENTS = 16`).
  - Per-connection sliding-window rate limit (`10` batches per `10s`); abusive sockets are closed with `ws::CloseCode::Policy`.
  - Idle timeout (`30s` without frames/pings) automatically closes idle connections.
- **ACK flow**:
  - Decode incoming binary frame as `TelemetryBatch`.
  - Emit each sanitized `TelemetryEvent` through `Arc<dyn TelemetrySink>`.
  - Reply with binary `TelemetryAck { ack_id: batch.ack_id }.encode_to_vec()` so the client can safely purge acknowledged keys from IndexedDB.

## Implementation Areas

- `server/src/telemetry/{mod.rs,sink.rs,sanitize.rs,ws_actor.rs,tests.rs}`
- `server/src/main.rs` (register `TelemetryState` app data + `/ws/telemetry`)

## Tests and Acceptance

- [x] Unauthenticated client with allowed `Origin` connects to `/ws/telemetry`, sends `TelemetryBatch`, triggers `TelemetrySink` with decoded `kind`/`op`/`providers`, and receives `TelemetryAck { ack_id }`.
- [x] Disallowed/missing `Origin`, oversized frames (`> 16 KiB`), malformed protobuf, excess batch events, connection-cap overflow, rate-limit bursts, and idle timeouts are handled safely without panicking or affecting `CHAT_ROOMS`.
- [x] Control characters, newlines, `month_session=...`, and long hex secrets in `message` are stripped/redacted before reaching `TelemetrySink`.
- [x] `bazel test //server:chat_db_test` passes with dedicated in-memory test `TelemetrySink` assertions.
