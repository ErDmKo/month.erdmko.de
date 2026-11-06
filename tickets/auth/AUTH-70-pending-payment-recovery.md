---
title: "Resume Pending Payments Without Duplicate Transfers"
ticket: "AUTH-70"
status: "planned"
draft: false
weight: 70
---

# AUTH-70 Resume Pending Payments Without Duplicate Transfers

**Priority: P0. Blocks paid-chat deployment.**

## Depends on

- [AUTH-30](AUTH-30-payment-nickname-contract.md)
- [AUTH-50](AUTH-50-browser-wallet-ui.md)

Coordinate payment configuration with [AUTH-80](AUTH-80-payment-network-consistency.md)
and replay-safe activation with [AUTH-90](AUTH-90-atomic-payment-activation.md).

## Goal

One payment attempt sends at most one transfer. Confirmation and claim retries reuse its transaction hash.

## Confirmed Bug

Browser reproduction on 2026-11-06 used the optimized bundle with a mocked wallet and HTTP claim response:

1. Restore an authenticated, unpaid profile and enter a valid nickname.
2. Click **Pay & Unlock Chat**. The wallet returns a transaction hash.
3. Return `400` with `Payment transaction is still pending confirmation.` from `/auth/claim-payment`.
4. Click **Pay & Unlock Chat** again after the error appears.
5. A second `eth_sendTransaction` request occurs with a new hash.

No real transfer was sent in this reproduction. The browser requested two transfers
because `payAndClaimTask` always sends before claiming and discards the pending hash.

## Scope

- Persist the returned hash before attempting a claim. Associate it with wallet, chain, and payment configuration.
- Represent sending, pending confirmation, claiming, activated, and failed states explicitly.
- Handle transaction-not-found immediately after submission and receipt-not-yet-available as pending states.
- Retry confirmation/claim with bounded backoff and an explicit resume action after timeout.
- Restore pending work after refresh, reconnect, or reauthentication; do not silently submit another transfer.
- Show the pending transaction and a verified explorer link for the selected chain.
- On a lost successful claim response, recover through session/access status or an idempotent claim result.
- Handle wallet rejection, reverted transactions, wrong sender, account/network changes, and nickname conflicts distinctly.
- Route progress and errors through the shared onboarding banner.

## Implementation Areas

- `assets/js/chat/auth/index.ts`, `api.ts`, and `wallet.ts`
- `assets/js/chat/chat-ui/onboarding.ts` and `join-form-handler.ts`
- `server/src/auth/payment.rs` and `server/src/pages/auth.rs`

## Tests and Acceptance

- [ ] Pending → retry → confirmed sends exactly one `eth_sendTransaction` request.
- [ ] Refreshing while pending resumes the same wallet/chain/hash.
- [ ] RPC timeout or transient not-found responses never trigger another transfer automatically.
- [ ] A successfully claimed hash cannot extend access twice, including after response loss.
- [ ] A nickname conflict can be corrected and the original transaction claimed.
- [ ] Returning from a room invite resumes that room after successful activation.
- [ ] Browser tests use deterministic wallet/RPC fixtures and the shipped optimized bundle.
