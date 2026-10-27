---
title: "SIWE Signature Verification & HTTP Session Endpoints"
ticket: "AUTH-20"
status: "completed"
draft: false
weight: 20
---

# AUTH-20 SIWE Signature Verification & HTTP Session Endpoints

## Depends on
- `AUTH-10`

## Goal
Implement EIP-4361 (Sign-In with Ethereum) message parsing, secp256k1 `personal_sign` signature recovery, and HTTP endpoints that issue and clear `HttpOnly` session cookies.

## Scope

### EIP-4361 message & signature verification (`server/src/auth/siwe.rs`)
- Parse and validate SIWE fields:
  - `domain` matches configured server domain (`DOMAIN` env / `erdmko.dev` or `localhost:8080` in dev).
  - `address` normalizes via `normalize_wallet_address`.
  - `uri`, `version` (`1`), `chain_id`, `nonce`, `issued_at`, and optional `expiration_time`.
- Compute EIP-191 `personal_sign` digest (`"\x19Ethereum Signed Message:\n" + len + message`) with Keccak-256, recover the secp256k1 public key from the 65-byte `(r, s, v)` signature, derive the 20-byte Ethereum address, and verify it matches `address`.
- Consume the single-use nonce via `auth::db::consume_nonce`.

### HTTP endpoints (`server/src/pages/auth.rs`)
- `POST /auth/nonce` — accepts `{ walletAddress }`, validates address, issues a 5-minute nonce, returns `{ nonce, expiresAt }`.
- `POST /auth/verify` — accepts `{ message, signature }`, verifies SIWE + signature + single-use nonce, creates a 7-day session in `auth_sessions`, and sets `Set-Cookie: month_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`.
- `GET /auth/session` — returns `{ walletAddress }` for the current session cookie or `401 Unauthorized`.
- `POST /auth/logout` — revokes the session in SQLite and clears the cookie.

## Deliverables
- `server/src/auth/siwe.rs`
- `server/src/pages/auth.rs` registered in `server/src/main.rs`
- Unit & integration tests for SIWE verification and session cookie lifecycle

## Tests
- Unit: valid EIP-4361 message + known test vector signature recovers the expected wallet address.
- Unit: wrong domain, wrong chain ID, expired challenge, tampered message, or mismatched signature is rejected.
- Integration: `POST /auth/nonce` → `POST /auth/verify` sets `HttpOnly` cookie and `GET /auth/session` returns normalized wallet address; replaying the same `/auth/verify` payload fails with `401`.

## Acceptance
- Login requires zero gas and no third-party OAuth or SIWE provider.
- Reused, expired, or wrong-domain challenges are rejected before session creation.

## Result

**Status: DONE**

### Implemented modules
- `server/src/auth/siwe.rs` — EIP-4361 message parser/formatter/validator (`parse_siwe_message`, `format_siwe_message`, `validate_siwe_message`), EIP-191 `personal_sign` digest & secp256k1 signature recovery via `sha3` (`Keccak256`) and `k256` (`VerifyingKey::recover_from_prehash`), and single-use SQLite nonce verification (`verify_siwe_and_consume_nonce`).
- `server/src/pages/auth.rs` — HTTP endpoints (`POST /auth/nonce`, `POST /auth/verify`, `GET /auth/session`, `POST /auth/logout`) registered in `server/src/main.rs`, issuing and revoking `HttpOnly; Secure; SameSite=Lax` `month_session` cookies.
