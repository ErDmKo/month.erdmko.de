---
title: "Verify Wallet Onboarding and the Linux Release Image"
ticket: "DEPLOY-20"
status: "completed"
draft: false
weight: 20
---

# DEPLOY-20 Verify Wallet Onboarding and the Linux Release Image

**Priority: P1. Final paid-chat release gate.**

## Depends on

- [AUTH-60](../auth/AUTH-60-authorized-room-broadcasts.md)
- [AUTH-70](../auth/AUTH-70-pending-payment-recovery.md)
- [AUTH-80](../auth/AUTH-80-payment-network-consistency.md)
- [AUTH-90](../auth/AUTH-90-atomic-payment-activation.md)
- [DEPLOY-10](DEPLOY-10-accurate-chat-product-copy.md)

Related: [ASSETS-60](../assets/ASSETS-60-e2e-tests.md) for attachment coverage.
Reuse and update the existing browser harness instead of creating a parallel one.

## Goal

Demonstrate that the built application supports new purchases and returning paid users,
rejects unauthorized room access, and retains access records across deployment restarts.

## Review

1. **Clear boundary between Puppeteer E2E and Linux container smoke checks**
   - Full SIWE challenge/verification, ETH payment claiming, pending/reverted/nickname-conflict recovery, WebSocket authorization, HTTPS/`wss://` reverse-proxy cookie/upgrade behavior, and SQLite persistence across server restarts are deterministically verified by the Puppeteer Page Object E2E suite (`tests/e2e/suites/wallet-onboarding.test.ts`) and Rust integration tests (`//server:chat_db_test`).
   - Re-running the full SIWE + payment flow inside Docker would only duplicate application-level tests. Instead, the Linux container check targets the exact risks unique to `Dockerfile`: `linux/amd64` cross-compilation and git stamping, `debian:bookworm-slim` shared library linkage (`libsqlite3-0`, `libgstreamer1.0-0`, `ca-certificates`), packaged `/app/assets` + `/app/server/templates` resolution, and `/app/server/db/main.db` persistence across container recreation on a mounted Docker volume.
2. **Consolidate liveness and build metadata on `GET /version` (remove `/healthz`)**
   - `GET /version` executes on the same Actix HTTP worker pool, returns `200 OK`, and reports stamped `{ branch, commit, short_commit, dirty, build_time }` JSON, strictly subsuming an empty `/healthz` route.
   - Removed `/healthz` from `server/src/main.rs` and updated `docker-compose.yaml` (`autoheal` healthcheck), `tests/e2e/helpers/server.ts` readiness polling, `server/src/pages/chat/tests/voice.rs`, and `README.md` to use `GET /version` exclusively.

## Scope

- Diagnose startup with captured process exit status and logs; use realistic, bounded readiness/navigation timeouts.
- Check `/version` readiness and always clean up child processes and temporary databases after setup failures.
- Update browser helpers and Page Objects (`tests/e2e/pages/*`) for `/chat` onboarding, room redirects, and automatic joining.
- Exercise the shipped Closure-optimized bundle against real HTTP/WebSocket handlers (using binary Protobuf `application/x-protobuf` across all `/auth/*` endpoints and WebSocket frames).
- Use isolated databases, test-only signing keys, and deterministic wallet/RPC fixtures for automated payments.
- Keep private keys and session cookies out of test reports. Test records must not become production startup seeds.
- Build and smoke-test the `linux/amd64` Docker image from the candidate commit (`GET /version`, `GET /chat`, static bundles, `/auth/nonce`, and `/app/server/db/main.db` volume persistence across container recreation).
- Document effective public origin, SIWE domain, cookie behavior, payment configuration, and WebSocket proxy settings.
- Record results with candidate commit, environment, commands, and actual pass/fail evidence.

## Required Scenarios

- [x] New wallet: nonce → SIWE signature → session → payment → confirmation → access → room auto-join (`wallet-onboarding.test.ts`).
- [x] Returning paid wallet: refresh and reconnect restore the correct wallet/nickname without another payment (`wallet-onboarding.test.ts`).
- [x] Room invite: anonymous/unpaid visitor sees room-specific onboarding and returns to the same room after activation (`wallet-onboarding.test.ts`).
- [x] Wrong chain, rejected signature/transfer, pending/reverted payment, RPC failure, and nickname conflict give actionable feedback (`wallet-onboarding.test.ts`, `auth.test.ts`).
- [x] Pending payment survives refresh and retries without a second transfer (`wallet-onboarding.test.ts`, `auth.test.ts`).
- [x] Duplicate/concurrent claims and lost responses never grant duplicate access (`//server:chat_db_test` — `auth::db::tests` & `pages::auth::tests`).
- [x] Anonymous, unpaid, expired, revoked, and unjoined WebSocket clients cannot receive room data (`wallet-onboarding.test.ts`, `//server:chat_db_test` — `messaging.rs`).
- [x] Authorized members exchange text, upload/download attachments, and join/leave voice (`bundles.test.ts`, `attachments-ui.test.ts`).
- [x] Secure session cookies and WSS work through an HTTPS deployment-like endpoint (`wallet-onboarding.test.ts` + `tests/e2e/helpers/tls-proxy.ts`).
- [x] Database activation failure rolls back, and retry can recover (`//server:chat_db_test` — `auth::db::tests`).
- [x] Linux image starts healthy (`GET /version`) and preserves `/app/server/db/main.db` across container replacement (`npm run build` + `what_amonth:latest` volume smoke test).
- [x] `bazel test //...` and the updated browser suite (`cd tests/e2e && npm test -- --runInBand`) pass.

## Deployment Configuration Reference

| Setting | Production Value / Behavior | Source |
| --- | --- | --- |
| Public origin | `https://erdmko.dev` | `DOMAIN` (`server/BUILD.bazel`, `server/src/pages/utils.rs`) |
| SIWE domain & WS `Origin` allowlist | `erdmko.dev`, `erdmko.dev:443`, `DOMAIN` override, plus `localhost[:port]` / `127.0.0.1[:port]` in local/test runs | `server/src/auth/siwe.rs`, `server/src/chat/service.rs` |
| Session cookie | `month_session=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (30 days) | `server/src/pages/auth.rs` |
| `ETH_CHAIN_ID` | `1` (Ethereum Mainnet) | `ansible/inventory.yaml` → `docker-compose.yaml` |
| `ETH_RPC_URL` | `https://ethereum-rpc.publicnode.com` (server-only; never serialized into browser protobuf payloads) | `ansible/inventory.yaml` → `docker-compose.yaml` |
| `PAYMENT_RECIPIENT_ADDRESS` | `0xeff121f128e0e64c0e64ae8eb6eb042a0e5aa81c` | `ansible/inventory.yaml` → `docker-compose.yaml` |
| `MIN_PAYMENT_WEI` | `1000000000000000` (`0.001 ETH` / `0x38d7ea4c68000`) | `ansible/inventory.yaml` → `docker-compose.yaml` |
| `ACCESS_DURATION_SECS` | `2592000` (`30 days`) | `ansible/inventory.yaml` → `docker-compose.yaml` |
| Persistent SQLite volume | `edk:/app/server/db` (`/app/server/db/main.db`) | `Dockerfile`, `docker-compose.yaml` |
| Health & version probe | `GET /version` (`wget -qO- http://127.0.0.1:8080/version`, monitored by `autoheal`) | `docker-compose.yaml`, `server/src/version.rs` |
| Reverse-proxy WebSocket (`/ws/chat/{room}`) | Forward `Upgrade: websocket`, `Connection: upgrade`, `Host`, `Origin`, `Cookie`, `X-Forwarded-Proto: https` with proxy buffering disabled | `README.md`, verified via `tests/e2e/helpers/tls-proxy.ts` |

## Verification Results

- **Date:** `2026-11-11`
- **Base commit verified:** `98e0e2c` (+ `DEPLOY-20` `/version` & TLS proxy test changes)
- **Host environment:** macOS (`darwin/arm64`), Bazel `9.1.0`, Node.js `24.14.1`, Docker Engine `27.4.0` (`linux/amd64` target image `what_amonth:latest`)

### 1. Formatting & Bazel Unit / Integration Suite
Command:
```bash
bazel run //tools/format:format && bazel test //... --test_output=errors
```
Result: **PASS — 15 / 15 test targets passed** (`//server:chat_db_test`, 10 frontend TS unit suites including `auth.test`, `protocol.test`, `attachments-proto.test`, `chat-ui.test`, `voice.test`, and 4 format checks: prettier JS/TS, prettier CSS, rustfmt, buildifier).

### 2. Real-Browser Puppeteer Page Object E2E Suite (Closure `ADVANCED` Bundles)
Command:
```bash
cd tests/e2e && npm test -- --runInBand
```
Result: **PASS — 4 / 4 suites, 18 / 18 tests passed (`24.25s`)**:
- `suites/page-object-enforcement.test.ts` (1 test): verifies zero direct Puppeteer DOM/navigation calls outside `tests/e2e/pages/`.
- `suites/wallet-onboarding.test.ts` (5 tests):
  1. Anonymous `/chat/{room}` → `303` `/chat?room={room}` invite redirect, real secp256k1 SIWE sign-in, ETH transfer + binary protobuf `/auth/claim-payment`, auto-join room, and returning session reload with zero extra transfers.
  2. Pending payment reload recovery (`localStorage` tx hash), `NicknameTaken` conflict handling, and activation with a free nickname without a second ETH transfer.
  3. Wrong chain (`0x2105` → `wallet_switchEthereumChain` rejection), rejected SIWE signature, upstream JSON-RPC error, and reverted transaction recovery.
  4. Anonymous HTTP/WebSocket rejection + persistent `BASE_PATH` server stop/restart retaining SQLite sessions, paid access, and chat messages (tested with Sepolia `11155111` / `0.002 ETH` / `7 days` override).
  5. HTTPS + `wss://` TLS-terminating reverse proxy (`https://localhost:<ephemeral>`) enforcing `Secure; HttpOnly; SameSite=Lax` `month_session` cookies, rejecting anonymous `wss://`, and exchanging binary protobuf chat frames over `wss://`.
- `suites/bundles.test.ts` (7 tests): `month`, `tennis` (score + speech), `tetris`, `snowflake`, `chat` messaging, and `chat` WebRTC voice join/mute/leave.
- `suites/attachments-ui.test.ts` (5 tests): file preview, cancel, chunked upload, chunk progress, and verified UTF-8 download.

### 3. Linux `amd64` Release Image Build & Volume Persistence Smoke Test
Command:
```bash
npm run build
# Ephemeral container c1 -> GET /version, GET /chat, GET /static/js/chat-bundle.js, POST /auth/nonce -> rm c1 -> start c2 on same Docker volume -> verify /version & /app/server/db/main.db -> cleanup c2 + volume
```
Result: **PASS**:
- `docker build . --platform linux/amd64 --tag what_amonth` succeeded cleanly (`bazel build //server:server` + `debian:bookworm-slim` runtime stage).
- Container #1 booted cleanly:
  - `GET /version` → `200 OK` (`{"branch":"master","short_commit":"98e0e2c",...}`)
  - `GET /healthz` → `404 Not Found` (confirming single `/version` health/version endpoint)
  - `GET /chat` → `200 OK` referencing `/static/js/chat-bundle.js?v=98e0e2c`
  - `GET /static/js/chat-bundle.js` → `200 OK` (`34,693` bytes)
  - `POST /auth/nonce` (`application/x-protobuf`) → `200 OK`, initializing `/app/server/db/main.db` (`86,016` bytes) on the mounted volume.
- Container #1 was removed and Container #2 started with the same volume mounted at `/app/server/db`:
  - `GET /version` → `200 OK`
  - `/app/server/db/main.db` (`86,016` bytes) persisted intact across container replacement.
- All temporary test containers and volumes were removed immediately after verification.

*(Note: Production deployment via `npm run pub` and any optional real-wallet mainnet smoke test remain explicit operator actions.)*
