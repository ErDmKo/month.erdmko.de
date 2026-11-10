---
title: "Protobuf Payment Claim Contract & Typed Verification States (Backend)"
ticket: "AUTH-71"
status: "completed"
draft: false
weight: 71
---

# AUTH-71 Protobuf Payment Claim Contract & Typed Verification States (Backend)

**Priority: P0. Part of [AUTH-70](AUTH-70-pending-payment-recovery.md).**

## Depends on

- [AUTH-30](AUTH-30-payment-nickname-contract.md)
- Coordinate atomic activation and idempotent same-wallet retry with [AUTH-90](AUTH-90-atomic-payment-activation.md) and network config with [AUTH-80](AUTH-80-payment-network-consistency.md).

## Goal

Replace string-based payment/auth error codes with a `.proto`-generated binary contract (`oneof` / numeric discriminants) on the backend so `/auth/claim-payment` distinguishes pending onchain confirmation, nickname conflicts, and terminal transaction failures without string error codes.

## Problem

1. **String error codes instead of protobuf**:
   `server/src/auth/error.rs` and `server/src/pages/auth.rs` return JSON with string error codes (`"VALIDATION_ERROR"`, `"NICKNAME_TAKEN"`, `"PAYMENT_ALREADY_CLAIMED"`), defeating the reason protobuf was introduced (compact binary encoding, numeric tuple/variant constants generated from `.proto`, and zero string-comparison boilerplate in the client bundle).
2. **Collapsed RPC verification states in `server/src/auth/payment.rs`**:
   `validate_rpc_payment` collapses retryable states (`tx` not yet indexed by RPC, `receipt` still `None` in mempool) and terminal failures (`receipt.status == 0x0` reverted, wrong recipient, underpaid amount) into a single generic `AuthError::validation(...)`.

## Scope

- **Protobuf contract (`contracts/` & `server/src/generated/`)**:
  - Define the payment claim request/response and outcome variants in protobuf using `oneof` / numeric discriminants (supported by `prost` in Rust and `assets/js/tools/gen-proto.ts` in TypeScript) instead of string error codes:
    - `Activated` (returns verified wallet profile / session status: `wallet_address`, `nickname`, `access_until`, `has_active_access`)
    - `Pending` (transaction not yet visible on RPC or receipt not yet mined — retryable with the same `tx_hash`)
    - `NicknameTaken` (transaction is valid, but requested nickname is owned by another wallet — retryable with the same `tx_hash` and a new nickname)
    - `Reverted` (transaction receipt `status == 0x0` — terminal failure for this `tx_hash`)
    - `InvalidTransaction` (wrong recipient, sender mismatch, underpaid amount, or claimed by another wallet — terminal failure for this `tx_hash`)
    - `Unauthorized` (missing, expired, or revoked session cookie)
- **Backend RPC & handler implementation (`server/src/auth/payment.rs`, `server/src/auth/error.rs`, `server/src/pages/auth.rs`)**:
  - Update `validate_rpc_payment` and `AuthError` to return typed enum variants rather than string error codes.
  - If the same authenticated wallet re-submits an already-claimed `tx_hash` (e.g., after a lost HTTP response), return `Activated` with the current `WalletProfile` idempotently instead of failing.
  - Encode `/auth/claim-payment` protobuf responses so the frontend decodes numeric variant tags directly via `@month/gen/...`.

## Implementation Areas

- `contracts/` and `server/src/generated/`
- `assets/js/tools/gen-proto.ts` and `assets/js/BUILD.bazel` (if adding a new proto package or extending `chat.proto`)
- `server/src/auth/error.rs`
- `server/src/auth/payment.rs`
- `server/src/auth/db.rs`
- `server/src/pages/auth.rs`

## Tests and Acceptance

- [x] No string error codes (`"PAYMENT_PENDING"`, `"PAYMENT_REVERTED"`, etc.) are added to the contract; all payment claim outcomes are represented by `.proto`-generated numeric variants.
- [x] `validate_rpc_payment` distinguishes `tx == None` / `receipt == None` (pending/retryable) from `status == 0x0` (reverted), wrong recipient, wrong sender, and underpaid value.
- [x] `NICKNAME_TAKEN` does not consume `tx_hash` and returns the typed `NicknameTaken` variant so the caller can retry with a different nickname.
- [x] Same-wallet retry of an already-claimed `tx_hash` returns `Activated` idempotently without extending `access_until` a second time.

## Result

**Status: DONE**

### Implemented modules
- `contracts/chat/chat.proto`, `contracts/chat/BUILD.bazel`, `tools/prost/descriptor_to_json.rs`, `tools/prost/BUILD.bazel`, `server/src/generated/mod.rs` — defined `ClaimPaymentRequest` and `ClaimPaymentResponse` (`Activated`, `Pending`, `NicknameTaken`, `Reverted`, `InvalidTransaction`, `Unauthorized`) in `chat.proto` and wired Bazel (`//contracts/chat:chat_rs` and `//contracts/chat:chat_descriptor_json` -> `//assets/js:chat_ts`) so both Rust and TypeScript bindings are generated directly by Bazel without manual edits to generated files.
- `assets/js/utils/proto-utils.ts` & `assets/js/tools/gen-proto.ts` — added `encodeBoolField` and `bool` field codegen support for `PaymentClaimActivated`.
- `server/src/auth/payment.rs` — replaced generic `AuthError` returns in `validate_rpc_payment` and `PaymentVerifier` with `PaymentVerificationError` (`Pending`, `Reverted`, `InvalidTransaction`, `Internal`).
- `server/src/auth/db.rs` — implemented `claim_payment_atomically` and `ClaimPaymentDbError` (`NicknameTaken`, `InvalidTransaction`, `Internal`) with atomic SQLite transaction rollback and idempotent same-wallet retry.
- `server/src/pages/auth.rs` — updated `POST /auth/claim-payment` to decode binary protobuf `ClaimPaymentRequest` and return binary protobuf `ClaimPaymentResponse` (`application/x-protobuf`), with unit and HTTP tests covering all variants.
