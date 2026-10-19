---
title: "Wallet Identity & Session Data Layer"
ticket: "AUTH-10"
status: "completed"
draft: false
weight: 10
---

# AUTH-10 Wallet Identity & Session Data Layer

## Depends on
- none

## Goal
Build the foundational offchain module (`server/src/auth/`) for EVM wallet normalization, strict ASCII nickname validation, and SQLite persistence for single-use SIWE nonces and authenticated wallet sessions.

## Scope

### Identity & nickname validation (`server/src/auth/service.rs`)
- `normalize_wallet_address(raw: &str) -> AuthResult<String>`:
  - Trim whitespace, require `0x` or `0X` prefix followed by exactly 40 ASCII hex digits.
  - Return canonical lowercase `0x...` (42 bytes).
- `validate_ascii_nickname(raw: &str) -> AuthResult<String>`:
  - Trim whitespace, require length `1..=32` (`MAX_NICKNAME_LEN`).
  - Allow only lowercase ASCII `a-z`, `0-9`, `_`, and `-` to prevent Unicode homograph spoofing.
- Cryptographically random hex token generators (`generate_nonce`, `generate_session_token`).

### SQLite schema & operations (`server/src/auth/db.rs`)
- `auth_nonces` table:
  - `nonce TEXT PRIMARY KEY`
  - `wallet_address TEXT NOT NULL`
  - `created_at INTEGER NOT NULL`
  - `expires_at INTEGER NOT NULL`
  - `consumed_at INTEGER`
- `auth_sessions` table:
  - `token TEXT PRIMARY KEY`
  - `wallet_address TEXT NOT NULL`
  - `created_at INTEGER NOT NULL`
  - `expires_at INTEGER NOT NULL`
- Operations:
  - `init_auth_schema(conn)` — idempotent table + index creation, wired into `server/src/db.rs`.
  - `issue_nonce(conn, wallet_address, now_unix, ttl_secs)` — stores a fresh single-use nonce for a normalized wallet.
  - `consume_nonce(conn, nonce, wallet_address, now_unix)` — atomically marks the nonce consumed only if it exists, matches `wallet_address`, is unconsumed, and `expires_at > now_unix`.
  - `create_session(conn, wallet_address, now_unix, ttl_secs)` — creates a persistent session token for a verified wallet.
  - `get_valid_session_wallet(conn, token, now_unix)` — resolves an active session token to its normalized wallet address (`None` if unknown or expired).
  - `revoke_session(conn, token)` — deletes a session on logout.
  - `cleanup_expired_auth_records(conn, now_unix)` — prunes expired/consumed nonces and expired sessions.

## Deliverables
- `server/src/auth/mod.rs`, `error.rs`, `service.rs`, `db.rs`
- `server/src/db.rs` calls `crate::auth::db::init_auth_schema(&conn)?`
- Unit tests for validation, single-use nonce consumption, replay rejection, expiry, and session lifecycle

## Tests
- Unit: valid mixed-case EVM addresses normalize to lowercase `0x` + 40 hex chars; malformed addresses are rejected.
- Unit: lowercase ASCII nicknames `1..=32` pass; uppercase, spaces, Unicode lookalikes, or empty/oversized strings are rejected.
- Unit: `issue_nonce` + `consume_nonce` succeeds once and rejects replay, wrong wallet, or expired nonces.
- Unit: `create_session` + `get_valid_session_wallet` resolves active session, returns `None` when expired or revoked.
- Unit: `cleanup_expired_auth_records` removes expired/consumed nonces and expired sessions while keeping active ones.

## Acceptance
- `bazel test //server:chat_db_test` passes all auth unit and DB tests.
- No private keys or seed phrases are stored or accepted anywhere in the schema.

## Result

**Status: DONE**

### Implemented modules
- `server/src/auth/mod.rs` — constants (`NONCE_TTL_SECS = 300`, `SESSION_TTL_SECS = 604_800`, `WALLET_ADDRESS_LEN = 42`, `MAX_ASCII_NICKNAME_LEN = 32`) and submodule exports.
- `server/src/auth/error.rs` — `AuthError` and `AuthErrorKind` (`Validation`, `Unauthorized`, `Internal`).
- `server/src/auth/service.rs` — `normalize_wallet_address()`, `validate_ascii_nickname()`, `generate_nonce()`, and `generate_session_token()`.
- `server/src/auth/db.rs` — `init_auth_schema()`, `issue_nonce()`, `consume_nonce()`, `create_session()`, `get_valid_session_wallet()`, `revoke_session()`, and `cleanup_expired_auth_records()`.
- Wired into `server/src/main.rs` and `server/src/db.rs`.
