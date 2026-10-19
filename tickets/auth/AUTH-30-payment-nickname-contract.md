---
title: "Direct ETH Payment Receipt Verification via Public RPC"
ticket: "AUTH-30"
status: "pending"
draft: false
weight: 30
---

# AUTH-30 Direct ETH Payment Receipt Verification via Public RPC

## Depends on
- `AUTH-10`
- `AUTH-20`

## Goal
Verify direct ETH transfers sent to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c` using a lightweight JSON-RPC check against a public HTTPS RPC URL (`ETH_RPC_URL`) — without deploying a smart contract or running a self-hosted blockchain node — and unlock paid access in SQLite (`wallet_profiles` + `claimed_payments`).

## Scope

### JSON-RPC Payment Verifier (`server/src/auth/payment.rs`)
- Configuration via environment variables:
  - `ETH_RPC_URL` (e.g. `https://ethereum-rpc.publicnode.com` or `https://mainnet.base.org`)
  - `PAYMENT_RECIPIENT_ADDRESS` (defaults to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c`)
  - `MIN_PAYMENT_WEI` (minimum transfer value in wei required to unlock one access period)
  - `ACCESS_DURATION_SECS` (defaults to 30 days = `2_592_000` seconds)
- `PaymentVerifier` trait (for clean unit/integration testing without live network calls) + `RpcPaymentVerifier` implementation using `awc`:
  1. Normalize `tx_hash` via `normalize_tx_hash`.
  2. Call `eth_getTransactionByHash(tx_hash)` and `eth_getTransactionReceipt(tx_hash)`.
  3. Verify `receipt.status == "0x1"` (transaction confirmed and succeeded).
  4. Verify `tx.to` normalized equals `PAYMENT_RECIPIENT_ADDRESS`.
  5. Verify `tx.from` normalized equals the authenticated session's `wallet_address`.
  6. Parse hex `tx.value` (`u128`) and verify `value >= MIN_PAYMENT_WEI`.
- Persist via `auth::db::record_payment_and_extend_access` so each `tx_hash` can only ever be claimed once (`PAYMENT_ALREADY_CLAIMED` on replay).

### HTTP Endpoint (`server/src/pages/auth.rs`)
- `POST /auth/claim-payment`:
  - Requires active wallet session cookie (`month_session`).
  - Accepts `{ txHash, nickname? }`.
  - Verifies the transaction via `PaymentVerifier`, records the payment and extends `access_until` in SQLite, optionally sets/updates the user's unique nickname via `set_wallet_nickname`, and returns `{ walletAddress, nickname, accessUntil, hasActiveAccess: true }`.
- `POST /auth/nickname`:
  - Requires active wallet session with paid access (`has_active_access == true`).
  - Updates the wallet's unique ASCII nickname in `wallet_profiles`.

## Deliverables
- `server/src/auth/payment.rs` — `PaymentVerifier` trait, hex/wei parser, and JSON-RPC client
- `POST /auth/claim-payment` and `POST /auth/nickname` handlers
- Unit & integration tests with mocked JSON-RPC responses

## Tests
- Unit: parses hex wei quantities (`0x...`) and validates recipient, sender, minimum value, and `0x1` receipt status.
- Unit: rejects pending (`receipt: null`), reverted (`status: "0x0"`), wrong recipient, wrong sender, underpaid, or replayed `txHash`.
- Integration: `POST /auth/claim-payment` extends `access_until` in SQLite and rejects a second claim with the same `txHash`.

## Acceptance
- Zero smart contract deployment and zero self-hosted node required.
- Only one HTTPS RPC call occurs when a user submits a payment `txHash`; all subsequent access checks read SQLite locally.
