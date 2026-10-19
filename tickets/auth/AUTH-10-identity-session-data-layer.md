---
title: "Wallet Identity, Profile, Payment & Session Data Layer"
ticket: "AUTH-10"
status: "completed"
draft: false
weight: 10
---

# AUTH-10 Wallet Identity, Profile, Payment & Session Data Layer

## Depends on
- none

## Goal
Build the foundational offchain module (`server/src/auth/`) for EVM wallet normalization, transaction hash normalization, strict ASCII nickname validation, and SQLite persistence for single-use SIWE nonces, authenticated wallet sessions, unique wallet nicknames/access expiration (`wallet_profiles`), and replay-protected payment claims (`claimed_payments`).

## Scope

### Identity, nickname & tx-hash validation (`server/src/auth/service.rs`)
- `normalize_wallet_address(raw: &str) -> AuthResult<String>`:
  - Trim whitespace, require `0x`/`0X` prefix + 40 ASCII hex digits → lowercase `0x...` (42 chars).
- `normalize_tx_hash(raw: &str) -> AuthResult<String>`:
  - Trim whitespace, require `0x`/`0X` prefix + 64 ASCII hex digits → lowercase `0x...` (66 chars).
- `validate_ascii_nickname(raw: &str) -> AuthResult<String>`:
  - Trim whitespace, require length `1..=32`, allow only lowercase ASCII `a-z`, `0-9`, `_`, and `-`.
- Random hex generators (`generate_nonce`, `generate_session_token`).

### SQLite schema & operations (`server/src/auth/db.rs`)
- `auth_nonces`: `nonce PRIMARY KEY`, `wallet_address`, `created_at`, `expires_at`, `consumed_at`
- `auth_sessions`: `token PRIMARY KEY`, `wallet_address`, `created_at`, `expires_at`
- `wallet_profiles`: `wallet_address PRIMARY KEY`, `nickname TEXT UNIQUE`, `access_until INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER NOT NULL`
- `claimed_payments`: `tx_hash PRIMARY KEY`, `wallet_address TEXT NOT NULL`, `amount_wei TEXT NOT NULL`, `claimed_at INTEGER NOT NULL`
- Operations:
  - `init_auth_schema(conn)` — idempotent table + index creation, wired into `server/src/db.rs`.
  - `issue_nonce` & `consume_nonce` — single-use expiring SIWE challenge lifecycle.
  - `create_session`, `get_valid_session_wallet`, `revoke_session`, `cleanup_expired_auth_records`.
  - `get_wallet_profile(conn, wallet_address, now_unix)` — returns `WalletProfile` (`wallet_address`, `nickname`, `access_until`, `has_active_access`).
  - `set_wallet_nickname(conn, wallet_address, nickname, now_unix)` — assigns or updates a wallet's unique ASCII nickname, returning `NICKNAME_TAKEN` if owned by another wallet.
  - `record_payment_and_extend_access(conn, wallet_address, tx_hash, amount_wei, now_unix, duration_secs)` — atomically records `tx_hash` in `claimed_payments` (rejecting duplicates with `PAYMENT_ALREADY_CLAIMED`) and extends `access_until` by `duration_secs` (stacking on top of `MAX(access_until, now_unix)`).

## Deliverables
- `server/src/auth/mod.rs`, `error.rs`, `service.rs`, `db.rs`
- `server/src/db.rs` calls `crate::auth::db::init_auth_schema(&conn)?`
- Unit tests for validation, nonce consumption, session lifecycle, nickname uniqueness, and payment claim idempotency/stacking

## Acceptance
- `bazel test //server:chat_db_test` passes all auth unit and DB tests.

## Result

**Status: DONE**

### Implemented modules
- `server/src/auth/mod.rs` — constants (`RECIPIENT_WALLET_ADDRESS`, `NONCE_TTL_SECS`, `SESSION_TTL_SECS`, `DEFAULT_ACCESS_DURATION_SECS`, `WALLET_ADDRESS_LEN`, `TX_HASH_LEN`, `MAX_ASCII_NICKNAME_LEN`).
- `server/src/auth/error.rs` — `AuthError` and `AuthErrorKind` (`Validation`, `Conflict`, `Unauthorized`, `Internal`).
- `server/src/auth/service.rs` — `normalize_wallet_address()`, `normalize_tx_hash()`, `validate_ascii_nickname()`, `generate_nonce()`, and `generate_session_token()`.
- `server/src/auth/db.rs` — `init_auth_schema()`, `issue_nonce()`, `consume_nonce()`, `create_session()`, `get_valid_session_wallet()`, `revoke_session()`, `cleanup_expired_auth_records()`, `get_wallet_profile()`, `set_wallet_nickname()`, and `record_payment_and_extend_access()`.
