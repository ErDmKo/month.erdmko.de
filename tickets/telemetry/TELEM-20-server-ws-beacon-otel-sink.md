---
title: "Server /ws/telemetry Channel, Last-Resort Beacon & OpenTelemetry-Ready Sink"
ticket: "TELEM-20"
status: "planned"
draft: false
weight: 20
---

# TELEM-20 Server `/ws/telemetry` Channel, Last-Resort Beacon & OpenTelemetry-Ready Sink

**Priority: P2. Backend transport and server-only decoding for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- [`TELEM-10`](TELEM-10-contract-and-logger-removal.md)

## Goal

Provide an auth-independent, room-independent, SQLite-free server telemetry ingestion pipeline over WebSocket (`GET /ws/telemetry` with `TelemetryAck` confirmation) and a last-resort beacon endpoint (`POST /telemetry`), decoding compact Protobuf enums/bitmasks on the server into sanitized, OpenTelemetry-aligned records.

## Scope

### 1. OpenTelemetry-aligned `TelemetryRecord` & `TelemetrySink` (`server/src/telemetry/sink.rs`)
Define a clean server-side boundary modeled directly on the OpenTelemetry Logs Data Model so `opentelemetry_sdk` / `opentelemetry-otlp` can replace or wrap the default logger later without touching wire or handler code:

- `TelemetryRecord`:
  - `observed_timestamp_ms: i64` (server `Utc::now().timestamp_millis()`)
  - `client_timestamp_ms: u64` (clamped/validated client timestamp)
  - `severity_number: u8` (`13` = OpenTelemetry `WARN`)
  - `event_name: &'static str` (`"browser.error"`)
  - `transport: TelemetryTransport` (`Ws` | `Beacon`)
  - `kind: &'static str` (decoded on server from `TelemetryKind`: `"uncaught_error"`, `"unhandled_rejection"`, `"wallet_rpc"`, `"auth_http"`, `"ws"`, `"webrtc"`, `"unspecified"`)
  - `op: &'static str` (decoded on server from `TelemetryOp`: `"personal_sign"`, `"eth_sendTransaction"`, `"wallet_switchEthereumChain"`, `"auth_verify"`, etc.)
  - `code: String` (sanitized, max `64` ASCII/UTF-8 chars)
  - `message: String` (sanitized, max `256` chars)
  - `path: String` (sanitized URL path without query/fragment, max `128` chars)
  - `line: u32`, `column: u32`
  - `chain_id: u64`
  - `providers: &'static str` / decoded list from `provider_flags` bitmask (`"phantom"`, `"metamask"`, `"coinbase"`, `"rabby"`, `"brave"`, `"ethereum"`, `"none"`)
- `pub trait TelemetrySink: Send + Sync + 'static { fn emit(&self, record: &TelemetryRecord); }`
- Default `LogTelemetrySink`: emits single-line structured key-value `WARN` logs (`log::warn!(target: "telemetry", "event=browser.error transport={} kind={} op={} code={} chain_id={} providers={} path={} loc={}:{} client_ts={} msg={:?}", ...)`).

### 2. Server-side sanitization & secret scrubbing (`server/src/telemetry/sanitize.rs`)
- Strip ASCII control characters (`\r`, `\n`, `\t`, `\0`, `0x00..=0x1F`, `0x7F`) to prevent log injection.
- Strip query strings (`?...`) and fragments (`#...`) from `path`.
- Truncate `code` (`<= 64` chars), `message` (`<= 256` chars), and `path` (`<= 128` chars) on valid UTF-8 char boundaries.
- Scrub accidental secrets from `message`:
  - Hex sequences >= 64 hex chars (`0x[0-9a-fA-F]{64,}` — covers 65-byte SIWE signatures and raw session tokens; note: if `op == eth_sendTransaction` or `auth_claim_payment` needs nothing secret, keep redaction conservative or preserve prefix `0xABCD…` of 8 chars max).
  - `month_session=[^;\s]+` cookie substrings → `month_session=[REDACTED]`.

### 3. Primary WebSocket channel: `GET /ws/telemetry` (`server/src/telemetry/ws_actor.rs`)
- **Independent of auth and rooms**: does NOT read `month_session`, does NOT require paid access, and does NOT touch SQLite.
- **Reverse-proxy ready**: served under `/ws/telemetry`, which is already covered by production Nginx `location ^~ /ws/` (`Upgrade` + `Connection "upgrade"`) and `robots.txt` (`Disallow: /ws/`).
- **Admission & DoS guards**:
  - Require allowed `Origin` via `is_allowed_origin`.
  - Dedicated atomic connection counter (`MAX_TELEMETRY_CONNECTIONS = 64`), completely separate from `CHAT_ROOMS` (`MAX_OPEN_CONNECTIONS = 100`) so telemetry connections can never starve chat rooms.
  - Max binary frame size: `MAX_TELEMETRY_PAYLOAD_BYTES = 16 * 1024` (16 KiB).
  - Max events per batch: `MAX_TELEMETRY_BATCH_EVENTS = 16` (excess events dropped or frame rejected).
  - Per-connection sliding-window rate limit (e.g. `10` batches per `10s`); abusive sockets are closed with `ws::CloseCode::Policy`.
  - Idle timeout (`30s` without frames/pings) automatically closes idle connections.
- **ACK flow**:
  - Decode incoming binary frame as `TelemetryBatch`.
  - Emit each sanitized `TelemetryEvent` through `Arc<dyn TelemetrySink>`.
  - Reply with binary `TelemetryAck { ack_id: batch.ack_id }.encode_to_vec()` so the client can safely purge acknowledged keys from IndexedDB.

### 4. Last-resort beacon endpoint: `POST /telemetry` (`server/src/telemetry/http.rs`)
- Served at `POST /telemetry` (outside `/ws/` so Nginx `location ^~ /` proxies normal HTTP `POST` requests without `Connection: upgrade` headers).
- Require allowed `Origin` via `is_allowed_origin`.
- Enforce streaming/body size cap (`<= 16 KiB`) before allocation and global/per-IP sliding-window rate limit so unauthenticated beacons cannot flood logs.
- Decode `TelemetryBatch` (`application/x-protobuf` or `application/octet-stream` sent by `navigator.sendBeacon`), emit records with `transport = Beacon` to `Arc<dyn TelemetrySink>`, and return `204 No Content`.

## Implementation Areas

- `server/src/telemetry/{mod.rs,sink.rs,sanitize.rs,ws_actor.rs,http.rs}`
- `server/src/main.rs` (register `Arc<dyn TelemetrySink>` app data + `/ws/telemetry` + `/telemetry`)

## Tests and Acceptance

- [ ] Unauthenticated client with allowed `Origin` connects to `/ws/telemetry`, sends `TelemetryBatch`, triggers `TelemetrySink` with decoded `kind`/`op`/`providers`, and receives `TelemetryAck { ack_id }`.
- [ ] Disallowed/missing `Origin`, oversized frames (`> 16 KiB`), malformed protobuf, connection-cap overflow, and rate-limit bursts are rejected safely without panicking or affecting `CHAT_ROOMS`.
- [ ] `POST /telemetry` accepts valid beacon payloads (`204 No Content`), enforces `Origin` + `16 KiB` size + rate limits, and tags records with `transport=beacon`.
- [ ] Control characters, newlines, `month_session=...`, and long hex secrets in `message` are stripped/redacted before reaching `TelemetrySink`.
- [ ] `bazel test //server:chat_db_test` passes with dedicated in-memory test `TelemetrySink` assertions.
