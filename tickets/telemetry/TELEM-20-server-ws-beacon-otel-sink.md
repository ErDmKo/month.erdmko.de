---
title: "Stateless POST /telemetry Endpoint, Server Deduplication & OpenTelemetry Sink"
ticket: "TELEM-20"
status: "completed"
draft: false
weight: 20
---

# TELEM-20 Stateless `POST /telemetry` Endpoint, Server Deduplication & OpenTelemetry Sink

**Priority: P2. Backend transport, deduplication, and server-only decoding for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- [`TELEM-10`](TELEM-10-contract-and-logger-removal.md)

## Goal

Provide a stateless, auth-independent, room-independent, SQLite-free server telemetry ingestion pipeline over `POST /telemetry` (`204 No Content`), decoding compact Protobuf enums/bitmasks on the server into sanitized, deduplicated, OpenTelemetry-aligned `stdout` records.

## Implemented Scope

1. **OpenTelemetry-aligned `TelemetryRecord` & `TelemetrySink` (`server/src/telemetry/sink.rs`)**
   - Decodes `TelemetrySeverity` (`1/5/9/13/17/21`) into `TRACE|DEBUG|INFO|WARN|ERROR|FATAL`, `TelemetryKind`, `TelemetryOp`, and `TelemetryProviderFlag` bitmasks exclusively on the Rust server.
   - `StdoutTelemetrySink` emits single-line structured records (`[... ERROR telemetry] event=browser.error severity=ERROR kind=...`) directly to `std::io::stdout()`.
2. **Server-side sanitization & secret scrubbing (`server/src/telemetry/sanitize.rs`)**
   - Strips control characters, strips query/fragment strings from `path`, truncates `code` (`<= 64`), `message` (`<= 256`), and `path` (`<= 128`), and redacts `month_session=...` and `>= 64`-hex secrets.
3. **Stateless `POST /telemetry` & server deduplication (`server/src/telemetry/http.rs`, `server/src/telemetry/mod.rs`)**
   - Enforces `is_allowed_origin`, streaming body cap (`16 KiB`), batch count cap (`1..=16`), per-IP sliding-window rate limit (`429 Too Many Requests`), and `5s` server-side deduplication (`TelemetryState::should_emit`, `MAX_DEDUP_ENTRIES = 512`), returning `204 No Content`.

## Implementation Areas

- `server/src/telemetry/{mod.rs,sink.rs,sanitize.rs,http.rs,tests.rs}`
- `server/src/main.rs`

## Tests and Acceptance

- [x] Unauthenticated `POST /telemetry` with allowed `Origin` decodes `TelemetryBatch`, emits sanitized OpenTelemetry records via `TelemetrySink`, and returns `204 No Content`.
- [x] Missing/disallowed `Origin`, oversized streams (`> 16 KiB`), malformed protobuf, empty/excess batches, and rate-limit bursts are rejected safely; duplicate bursts within `5s` are suppressed while still returning `204`.
- [x] Control characters, newlines, `month_session=...`, and long hex secrets in `message` are scrubbed before reaching `TelemetrySink`.
- [x] `bazel test //server:chat_db_test` passes.
