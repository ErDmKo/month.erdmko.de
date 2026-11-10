---
title: "Commit Payment and Access Activation Atomically"
ticket: "AUTH-90"
status: "completed"
draft: false
weight: 90
---

# AUTH-90 Commit Payment and Access Activation Atomically

**Priority: P1. Blocks paid-chat deployment.**

## Depends on

- [AUTH-10](AUTH-10-identity-session-data-layer.md)
- [AUTH-30](AUTH-30-payment-nickname-contract.md)

## Goal

A verified payment either activates access with its nickname update, or leaves all related records unchanged.

## Evidence

Source review of `89bf688` on 2026-11-06 found three separate writes:

1. `post_auth_claim_payment_handler` calls `set_wallet_nickname`.
2. `record_payment_and_extend_access` inserts into `claimed_payments`.
3. The same function separately updates `wallet_profiles.access_until`.

There is no transaction around those writes. Failure after step 2 can leave a consumed
transaction hash without activated access. A replay rejection can also occur after a nickname update.
The partial-write failure scenario has not yet been fault-injection tested.

## Scope

- Keep external RPC verification outside the SQLite transaction.
- Commit nickname validation/assignment, payment recording, and access extension in one transaction.
- Preserve unique nickname ownership and transaction-hash replay protection under concurrent requests.
- Preserve duration stacking on `MAX(access_until, now)` exactly once per verified payment.
- Roll back every related mutation on failure, including nickname conflicts and duplicate claims.
- Define retry behavior for a committed claim whose HTTP response was lost, coordinating with AUTH-70.
- Keep schema initialization and migration non-destructive to existing profiles and payment history.

## Implementation Areas

- `server/src/auth/db.rs`
- `server/src/pages/auth.rs`
- Existing auth data-layer and HTTP tests

## Tests and Acceptance

- [x] Injected failures between writes leave no partial payment, nickname, or access mutation.
- [x] Two concurrent claims of one hash activate access once.
- [x] Replaying a hash cannot change the nickname or extend access again.
- [x] A nickname conflict leaves the transaction available for a corrected retry.
- [x] A successful claim updates all records together and survives server restart.
- [x] Existing paid users retain their remaining access when another valid payment is claimed.

## Result

**Status: DONE**

### Implemented modules
- `server/src/auth/db.rs` — implemented `claim_payment_atomically` (and transactional `record_payment_and_extend_access`), wrapping nickname ownership verification, `claimed_payments` insertion, and `wallet_profiles` access/nickname upsert in a single SQLite transaction, with idempotent same-wallet retry and fault-injection rollback tests.
- `server/src/pages/auth.rs` — updated `post_auth_claim_payment_handler` to keep RPC verification outside the SQLite transaction and commit nickname + payment + access atomically via `claim_payment_atomically`.
