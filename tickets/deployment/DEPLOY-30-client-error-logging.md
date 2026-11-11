---
title: "Forward Frontend Runtime and Wallet Errors to Server Logs"
ticket: "DEPLOY-30"
status: "planned"
draft: false
weight: 30
---

# DEPLOY-30 Forward Frontend Runtime and Wallet Errors to Server Logs

**Priority: P2. Observability and production debugging.**

## Goal

Surface client-side wallet RPC failures, SIWE/payment errors, WebSocket/WebRTC errors, and uncaught browser exceptions in structured server logs so wallet-specific regressions (such as Phantom vs. MetaMask EIP-1193/EIP-4361 behavior differences) can be diagnosed without requiring manual browser DevTools inspection.

## Evidence

While debugging Phantom wallet sign-in (`code: -32000`, `"The app's signature request cannot be shown as the address does not match the provided address for verification"`), the server logs only showed `POST /auth/nonce 200` with no visibility into the subsequent client-side `personal_sign` rejection or provider metadata (`isPhantom`, `isMetaMask`, `chainId`). Adding a temporary client log endpoint immediately isolated the EIP-55 checksum mismatch.

## Scope

- Define a compact Protobuf message in `contracts/chat/chat.proto` (e.g., `ClientErrorReport`) capturing:
  - error category (`wallet_rpc`, `auth_http`, `ws`, `webrtc`, `uncaught_error`, `unhandled_rejection`)
  - operation / RPC method name (e.g., `eth_requestAccounts`, `personal_sign`, `eth_sendTransaction`)
  - error code and message
  - non-sensitive provider/context metadata (page path, provider flags such as `isPhantom` / `isMetaMask`, chain ID)
- Expose a rate-limited, size-capped endpoint (e.g., `POST /auth/client-error` or `/api/client-error` accepting `application/x-protobuf`) that logs structured `WARN` entries via `log::warn!`.
- Redact or exclude secrets, signatures, session tokens, and private user content before transmission and logging.
- Hook `formatAuthError` / `ethereumRequestTask` error paths and global `error` / `unhandledrejection` listeners into the reporter on a best-effort, non-blocking basis.

## Implementation Areas

- `contracts/chat/chat.proto` and generated TypeScript/Rust bindings
- `server/src/pages/auth.rs` and `server/src/main.rs`
- `assets/js/chat/auth/wallet.ts` and `assets/js/chat/chat-ui/join-form-handler.ts`
- `assets/js/utils/logger.ts`

## Acceptance

- [ ] Client-side wallet RPC rejections and auth errors are reported to the server and logged with method, error code, message, and provider flags.
- [ ] Payload size is bounded and invalid/oversized requests are rejected without allocation spikes.
- [ ] Reporting is fire-and-forget and never blocks or breaks user-facing UI flows when offline or when the endpoint fails.
- [ ] Unit tests cover protobuf encoding/decoding and server endpoint validation.
