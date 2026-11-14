---
title: "Chat Bundle Error Hooks, Redaction & Browser E2E Verification"
ticket: "TELEM-40"
status: "completed"
draft: false
weight: 40
---

# TELEM-40 Chat Bundle Error Hooks, Redaction & Browser E2E Verification

**Priority: P2. End-to-end integration and verification for [`DEPLOY-30`](../deployment/DEPLOY-30-client-error-logging.md).**

## Depends on

- [`TELEM-20`](TELEM-20-server-ws-beacon-otel-sink.md)
- [`TELEM-30`](TELEM-30-client-idb-queue-and-ws-transport.md)

## Goal

Wire the binary telemetry reporter into `chat-bundle` only (covering uncaught runtime exceptions, wallet EIP-1193 RPC failures, `/auth/*` HTTP failures, chat WebSocket errors, and WebRTC voice errors) while keeping `@month/telemetry` completely generic, and verify the full online/offline/cross-reload lifecycle in unit, E2E, and live production tests.

## Implemented Scope

1. **Bundle & module boundary (`assets/js/chat/telemetry.ts`)**
   - `initChatTelemetry = once(initTelemetry)` initializes telemetry once per `Window` on `/chat` and `/chat/{room}` without `WeakMap`s or prop-drilling.
   - Isolates `detectProviderFlags` (`ETHEREUM`, `METAMASK`, `PHANTOM`, `COINBASE`, `RABBY`, `BRAVE`) and `chainId` enrichment inside `assets/js/chat/telemetry.ts`.
   - Leaves `month-bundle`, `tetris-bundle`, `tennis-bundle`, and `snowflake-bundle` free of telemetry runtime code.
2. **Error instrumentation across `assets/js/chat/`**
   - Global `error` and `unhandledrejection` hooks in `@month/telemetry`.
   - Wallet EIP-1193 RPC errors in `assets/js/chat/auth/wallet.ts` (`4001` downgraded to `WARN`, other RPC/missing-provider failures as `ERROR`).
   - `/auth/*` Protobuf HTTP errors in `assets/js/chat/auth/api.ts`.
   - Chat WebSocket connect/decode/`ServerError` frames and mount errors in `assets/js/chat/{index.ts,telemetry.ts,chat-ui/init.ts,protocol/incoming.ts}`.
   - WebRTC `getUserMedia`, SDP offer/answer, ICE failure, and `ServerVoiceError` signaling errors in `assets/js/chat/voice/index.ts` and `assets/js/chat/telemetry.ts`.
3. **Verification & bundle budget**
   - `tests/e2e/suites/telemetry.test.ts` (strictly via `ChatOnboardingPage` Page Object) verifies pre-auth Phantom `-32000` `stdout` logging, offline `localStorage` cross-reload persistence & `204` purge, query-string redaction, and zero debug/enum strings in `chat-bundle.js`.
   - `chat-bundle.js` = `35,697 B` raw / `12,585 B` Brotli-11; all 5 bundles = `23,635 B` Brotli-11 (`+69 B` / `+0.29%` net vs pre-`TELEM-10`).

## Implementation Areas

- `assets/js/chat/{telemetry.ts,index.ts}`
- `assets/js/chat/auth/{constants.ts,wallet.ts,api.ts,auth.test.ts}`
- `assets/js/chat/chat-ui/{events.ts,init.ts}`, `assets/js/chat/protocol/incoming.ts`, `assets/js/chat/voice/index.ts`
- `tests/e2e/helpers/{server.ts,wallet.ts}`, `tests/e2e/pages/chat-onboarding.page.ts`, `tests/e2e/suites/telemetry.test.ts`

## Tests and Acceptance

- [x] Pre-auth wallet RPC rejections on `/chat` appear in server `stdout` telemetry logs with decoded `severity`, `op`, `code`, `chain_id`, and `providers`.
- [x] Offline errors persist in `localStorage` across full page reloads and flush over `POST /telemetry` upon reconnect, purging `localStorage` on `204`.
- [x] `chat-bundle.js` contains zero `logger.ts` / `ws-logger.ts` debug strings and zero Protobuf enum label strings.
- [x] `bazel run //tools/format:format && bazel test //...` and Puppeteer Page Object E2E suites pass; verified live on `erdmko.dev` on desktop and Android Chrome + Phantom mobile.
