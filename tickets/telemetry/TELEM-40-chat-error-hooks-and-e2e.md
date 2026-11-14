---
title: "Chat Bundle Error Hooks, Redaction & Browser E2E Verification"
ticket: "TELEM-40"
status: "planned"
draft: false
weight: 40
---

# TELEM-40 Chat Bundle Error Hooks, Redaction & Browser E2E Verification

**Priority: P2. End-to-end integration and verification for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- [`TELEM-20`](TELEM-20-server-ws-beacon-otel-sink.md)
- [`TELEM-30`](TELEM-30-client-idb-queue-and-ws-transport.md)

## Goal

Wire the binary telemetry reporter into `chat-bundle` (covering uncaught runtime exceptions, wallet EIP-1193 RPC failures, `/auth/*` HTTP failures, chat WebSocket errors, and WebRTC voice errors) with strict client-side redaction, and verify the full online/offline/beacon lifecycle in unit and Page Object E2E suites while keeping other bundles untouched.

## Scope

### 1. Bundle boundary (`chat-bundle` only)
- Initialize telemetry in `assets/js/chat-effect.ts` / `assets/js/chat/index.ts` (covers both `/chat` onboarding and `/chat/{room}` pages).
- Leave `month-bundle`, `tetris-bundle`, `tennis-bundle`, and `snowflake-bundle` untouched while keeping `assets/js/telemetry/` free of any `chat` imports so other bundles can opt in later.

### 2. Wallet provider bitmask & client redaction helper
- Inspect `ctx.ethereum` via closure-free `objectStruct` + `validate` to compute `provider_flags` (`ETHEREUM = 1`, `METAMASK = 2`, `PHANTOM = 4`, `COINBASE = 8`, `RABBY = 16`, `BRAVE = 32`).
- Record `ctx.location.pathname` only (never `search` or `hash`), cap `message` to `256` chars and `code` to `64` chars before encoding, and never pass SIWE message bodies, signatures, session cookies, chat message bodies, or attachment filenames/bytes into telemetry events.

### 3. Error instrumentation points in `assets/js/chat/`
All instrumentation uses numeric `TelemetryKind` and `TelemetryOp` enum constants from `@month/gen/telemetry` (zero operation/category strings in bundle):

1. **Global runtime hooks (`assets/js/chat-effect.ts`)**
   - `ctx.addEventListener('error', ...)`: emits `TELEMETRY_KIND_UNCAUGHT_ERROR` with `message`, `path`, `lineno`, `colno`.
   - `ctx.addEventListener('unhandledrejection', ...)`: emits `TELEMETRY_KIND_UNHANDLED_REJECTION` with extracted error `code` and `message`.
2. **Wallet EIP-1193 RPC (`assets/js/chat/auth/wallet.ts`)**
   - Map each `ethereumRequestTask` call to its numeric `TelemetryOp` (`ETH_CHAIN_ID`, `WALLET_SWITCH_ETHEREUM_CHAIN`, `ETH_REQUEST_ACCOUNTS`, `PERSONAL_SIGN`, `ETH_SEND_TRANSACTION`).
   - On provider rejection or missing `window.ethereum`, emit `TELEMETRY_KIND_WALLET_RPC` with `op`, provider error `code` (e.g. `"-32000"`, `"4001"`), `message`, active `chain_id`, and `provider_flags`.
3. **Auth Protobuf HTTP (`assets/js/chat/auth/api.ts`)**
   - On network error, non-2xx HTTP status, or malformed protobuf response across `/auth/nonce`, `/auth/verify`, `/auth/claim-payment`, `/auth/nickname`, and `/auth/logout` (excluding normal unauthenticated `/auth/session` `null`), emit `TELEMETRY_KIND_AUTH_HTTP` with `op`, HTTP status or error `code`, `message`, `chain_id`, and `provider_flags`.
4. **Chat WebSocket (`assets/js/chat/chat-ui/init.ts`, `assets/js/chat/protocol/incoming.ts`)**
   - `ws.onerror` → `TELEMETRY_KIND_WS` + `TELEMETRY_OP_WS_CONNECT`.
   - Malformed `ServerFrame` decode (`parseBinaryFrame` returning `null` on non-empty buffer) → `TELEMETRY_KIND_WS` + `TELEMETRY_OP_WS_DECODE`.
   - `ServerError` frame → `TELEMETRY_KIND_WS` + `TELEMETRY_OP_WS_SERVER_ERROR` with server `code` and `message`.
   - `initChatUi` / `initMessages` / `initAttachments` mount failure → `TELEMETRY_KIND_UNCAUGHT_ERROR` + `TELEMETRY_OP_CHAT_INIT`.
5. **WebRTC Voice (`assets/js/chat/voice/index.ts`, `assets/js/chat/voice/peer.ts`)**
   - `getUserMedia` rejection → `TELEMETRY_KIND_WEBRTC` + `TELEMETRY_OP_VOICE_GUM` (`err.name` as `code`, e.g. `"NotAllowedError"`).
   - SDP offer / remote answer / `addIceCandidate` rejection → `TELEMETRY_KIND_WEBRTC` + `TELEMETRY_OP_VOICE_OFFER` / `VOICE_ANSWER` / `VOICE_ICE`.
   - `iceConnectionState === 'failed'` → `TELEMETRY_KIND_WEBRTC` + `TELEMETRY_OP_VOICE_ICE` (`code = "ice_failed"`).
   - `ServerVoiceError` frame → `TELEMETRY_KIND_WEBRTC` + `TELEMETRY_OP_VOICE_SIGNALING` (`code = value[SERVER_VOICE_ERROR_CODE]`).

### 4. Browser E2E & bundle-bloat verification (`tests/e2e/`)
- Follow Page Object Model rules strictly (`tests/e2e/pages/` encapsulates all browser/DOM/network interactions; `tests/e2e/suites/page-object-enforcement.test.ts` must pass).
- Add `tests/e2e/suites/telemetry.test.ts` verifying against the Closure `ADVANCED` `chat-bundle.js` and real Rust server:
  1. **Live wallet RPC failure over `/ws/telemetry`**: mock Phantom provider (`isPhantom: true`) rejects `personal_sign` with `{ code: -32000, message: "checksum mismatch" }` on `/chat` (unauthenticated!) → client opens `/ws/telemetry`, receives `TelemetryAck`, clears IndexedDB queue, and server logs structured `event=browser.error severity=13 kind=wallet_rpc op=personal_sign code="-32000" chain_id=1 providers=ethereum,phantom`.
  2. **Offline IndexedDB persistence & reconnect flush**: trigger an error while offline (`page.setOfflineMode(true)`), reload page while still offline, restore connectivity (`setOfflineMode(false)`), and verify the stored binary event flushes over `/ws/telemetry` and is deleted after `TelemetryAck`.
  3. **Bundle string audit**: assert compiled `chat-bundle.js` contains zero `ws-logger` frame-name tables, zero `localStorage` `'debug'` checks, and zero `TELEMETRY_KIND_*` / `TELEMETRY_OP_*` enum identifier strings.

## Implementation Areas

- `assets/js/chat-effect.ts`, `assets/js/chat/index.ts`
- `assets/js/chat/auth/{wallet.ts,api.ts}`
- `assets/js/chat/chat-ui/init.ts`, `assets/js/chat/protocol/incoming.ts`
- `assets/js/chat/voice/{index.ts,peer.ts}`
- `tests/e2e/pages/`, `tests/e2e/suites/telemetry.test.ts`

## Tests and Acceptance

- [ ] Phantom/MetaMask RPC rejections on `/chat` (before any session cookie exists) appear in server telemetry logs with decoded `op`, `code`, `chain_id`, and `providers`.
- [ ] Offline errors survive page reload in IndexedDB and flush automatically over `/ws/telemetry` upon reconnect, purging IndexedDB only after `TelemetryAck`.
- [ ] `chat-bundle.js` contains no `logger.ts` / `ws-logger.ts` debug strings or Protobuf enum label strings.
- [ ] `bazel run //tools/format:format && bazel test //...` and `cd tests/e2e && npm test -- --runInBand` pass.
