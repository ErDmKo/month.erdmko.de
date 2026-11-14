---
title: "Telemetry Protobuf Contract, Enum Codegen & Debug Logger Removal"
ticket: "TELEM-10"
status: "completed"
draft: false
weight: 10
---

# TELEM-10 Telemetry Protobuf Contract, Enum Codegen & Debug Logger Removal

**Priority: P2. Foundation for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- none

## Goal

Remove all opt-in client console debug loggers (`logger.ts`, `ws-logger.ts`, `voiceLog`) to strip debug string literals from browser bundles, and establish a standalone `contracts/telemetry/telemetry.proto` package using numeric Protobuf enums/varints so human-readable decoding occurs exclusively on the Rust server.

## Scope

### 1. Remove opt-in client console debug logger
- Delete `assets/js/utils/logger.ts` and `assets/js/utils/ws-logger.ts`.
- Remove `export * from './logger'` and `export * from './ws-logger'` from `assets/js/utils/index.ts`.
- Remove `logIncomingFrame` from `assets/js/chat/protocol/incoming.ts` and `logOutgoingFrame` from `assets/js/chat/protocol/outgoing.ts`.
- Remove `createLogger('voice')` / `voiceLog(...)` calls from `assets/js/chat/voice/index.ts` and `assets/js/chat/voice/peer.ts`.

### 2. Protobuf `enum` support in descriptor & TS codegen
- Update `tools/prost/descriptor_to_json.rs` and `server/build.rs`:
  - Map `prost_types::field_descriptor_proto::Type::Enum` fields to `"uint32"` (wire-identical varint on the client).
  - Emit top-level `enums: [{ name, values: [{ name, number }] }]` in `<package>.descriptor.json`.
- Update `assets/js/tools/gen-proto.ts`:
  - Emit numeric constants `export const <VALUE_NAME> = <number> as const;` for each enum entry (no string maps or reverse lookup tables in TypeScript so Closure Compiler `ADVANCED` folds every enum constant to a bare integer literal).

### 3. Standalone `contracts/telemetry/telemetry.proto`
Create `contracts/telemetry/telemetry.proto` (`package telemetry;`) and `contracts/telemetry/BUILD.bazel` (`telemetry_proto`, `telemetry_rs`, `telemetry_descriptor_json`):

```protobuf
syntax = "proto3";

package telemetry;

enum TelemetryKind {
  TELEMETRY_KIND_UNSPECIFIED         = 0;
  TELEMETRY_KIND_UNCAUGHT_ERROR      = 1;
  TELEMETRY_KIND_UNHANDLED_REJECTION = 2;
  TELEMETRY_KIND_WALLET_RPC          = 3;
  TELEMETRY_KIND_AUTH_HTTP           = 4;
  TELEMETRY_KIND_WS                  = 5;
  TELEMETRY_KIND_WEBRTC              = 6;
}

enum TelemetryOp {
  TELEMETRY_OP_UNSPECIFIED                  = 0;
  TELEMETRY_OP_ETH_CHAIN_ID                 = 1;
  TELEMETRY_OP_WALLET_SWITCH_ETHEREUM_CHAIN = 2;
  TELEMETRY_OP_ETH_REQUEST_ACCOUNTS         = 3;
  TELEMETRY_OP_PERSONAL_SIGN                = 4;
  TELEMETRY_OP_ETH_SEND_TRANSACTION         = 5;
  TELEMETRY_OP_AUTH_SESSION                 = 6;
  TELEMETRY_OP_AUTH_NONCE                   = 7;
  TELEMETRY_OP_AUTH_VERIFY                  = 8;
  TELEMETRY_OP_AUTH_CLAIM_PAYMENT           = 9;
  TELEMETRY_OP_AUTH_NICKNAME                = 10;
  TELEMETRY_OP_AUTH_LOGOUT                  = 11;
  TELEMETRY_OP_CHAT_INIT                    = 12;
  TELEMETRY_OP_WS_CONNECT                   = 13;
  TELEMETRY_OP_WS_DECODE                    = 14;
  TELEMETRY_OP_WS_SERVER_ERROR              = 15;
  TELEMETRY_OP_VOICE_GUM                    = 16;
  TELEMETRY_OP_VOICE_OFFER                  = 17;
  TELEMETRY_OP_VOICE_ANSWER                 = 18;
  TELEMETRY_OP_VOICE_ICE                    = 19;
  TELEMETRY_OP_VOICE_SIGNALING              = 20;
}

enum TelemetryProviderFlag {
  TELEMETRY_PROVIDER_FLAG_NONE     = 0;
  TELEMETRY_PROVIDER_FLAG_ETHEREUM = 1;
  TELEMETRY_PROVIDER_FLAG_METAMASK = 2;
  TELEMETRY_PROVIDER_FLAG_PHANTOM  = 4;
  TELEMETRY_PROVIDER_FLAG_COINBASE = 8;
  TELEMETRY_PROVIDER_FLAG_RABBY    = 16;
  TELEMETRY_PROVIDER_FLAG_BRAVE    = 32;
}

message TelemetryEvent {
  uint64        timestamp_ms   = 1;
  TelemetryKind kind           = 2;
  TelemetryOp   op             = 3;
  string        code           = 4; // Supports negative JSON-RPC codes ("-32000"), HTTP statuses ("500"), and symbolic codes
  string        message        = 5;
  string        path           = 6;
  uint32        line           = 7;
  uint32        column         = 8;
  uint64        chain_id       = 9;
  uint32        provider_flags = 10;
}

message TelemetryBatch {
  uint32                  ack_id = 1;
  repeated TelemetryEvent events = 2;
}

message TelemetryAck {
  uint32 ack_id = 1;
}
```

> Note: `code` is `string` rather than `int32` because `encodeVarint` in `assets/js/utils/proto-utils.ts` encodes non-negative varints only, whereas EIP-1193 JSON-RPC error codes are negative (`-32000`, `-32603`) alongside string error codes (`NotAllowedError`, `PAYMENT_REQUIRED`).

### 4. Bazel & editor codegen wiring
- Add `genrule(name = "telemetry_ts", ...)` to `assets/js/BUILD.bazel` and include `:telemetry_ts` in `ts_project(name = "gen")`.
- Add `@month/gen/telemetry` path mapping to `assets/js/tsconfig.json` and copy `gen/telemetry.ts` in `script/gen.ts` (`npm run gen`).
- Add `//contracts/telemetry:telemetry_rs` to `server/BUILD.bazel` (`server` and `chat_db_test`) and re-export `pub use telemetry_proto::telemetry;` in `server/src/generated/mod.rs`.

## Implementation Areas

- `assets/js/utils/logger.ts` (delete)
- `assets/js/utils/ws-logger.ts` (delete)
- `assets/js/utils/index.ts`
- `assets/js/chat/protocol/{incoming.ts,outgoing.ts}`
- `assets/js/chat/voice/{index.ts,peer.ts}`
- `contracts/telemetry/{BUILD.bazel,telemetry.proto}`
- `tools/prost/descriptor_to_json.rs`, `server/build.rs`, `assets/js/tools/gen-proto.ts`
- `assets/js/BUILD.bazel`, `assets/js/tsconfig.json`, `script/gen.ts`
- `server/BUILD.bazel`, `server/src/generated/mod.rs`

## Tests and Acceptance

- [x] `logger.ts` and `ws-logger.ts` are removed; zero `localStorage.getItem('debug')` or `ws-logger` variant name tables remain in `assets/js/`.
- [x] `bazel build //contracts/telemetry:telemetry_rs //assets/js:telemetry_ts` and `npm run gen` succeed cleanly.
- [x] Generated `gen/telemetry.ts` exports numeric `as const` enum constants with zero enum-name string literals.
- [x] Unit tests verify roundtrip binary compatibility between TS `encodeTelemetryEvent` / `encodeTelemetryBatch` / `decodeTelemetryAck` and wire expectations (including `timestamp_ms = Date.now()` 41-bit varints and negative RPC codes in `code`).
- [x] `bazel test //...` passes.
