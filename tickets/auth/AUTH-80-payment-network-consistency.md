---
title: "Align Wallet Network and Server Payment Configuration"
ticket: "AUTH-80"
status: "planned"
draft: false
weight: 80
---

# AUTH-80 Align Wallet Network and Server Payment Configuration

**Priority: P1. Blocks paid-chat deployment.**

## Depends on

- [AUTH-30](AUTH-30-payment-nickname-contract.md)
- [AUTH-50](AUTH-50-browser-wallet-ui.md)

## Goal

The wallet sends the intended amount to the intended recipient on the same chain the server verifies.

## Evidence

Code review of `89bf688` on 2026-11-06 found:

- `sendPaymentTransactionTask` calls `eth_sendTransaction` without checking `eth_chainId`.
- `buildSiweMessage` defaults to chain ID `1` regardless of the selected wallet network.
- The server defaults to the Ethereum mainnet RPC at `https://ethereum-rpc.publicnode.com`.
- The browser hardcodes the recipient and `0.001 ETH`, while the server accepts environment overrides.
- Compose currently passes voice configuration only, so payment settings use server defaults.

A wallet on another network can send a transfer that the configured verifier cannot find.
This was identified in source review; no cross-chain transfer was attempted.

## Scope

- Define one supported chain for this release; use Ethereum mainnet unless explicitly configured otherwise.
- Expose public payment configuration: chain ID, recipient, amount in wei, and access duration.
- Make browser display, transfer construction, SIWE chain selection, and server verification agree.
- Check `eth_chainId` before requesting payment; switch to the supported chain or stop with a clear message.
- Handle rejected/unsupported chain switches and account/network changes during onboarding.
- Keep pending payments associated with their original chain and wallet (AUTH-70).
- Validate RPC chain identity and reject inconsistent configuration before accepting payments.
- Document and wire the settings through Compose/Ansible without exposing private RPC credentials to the browser.

## Implementation Areas

- `assets/js/chat/auth/wallet.ts` and `index.ts`
- `assets/js/chat/chat-ui/onboarding.ts`
- `server/src/auth/payment.rs`, `siwe.rs`, and `server/src/pages/auth.rs`
- `docker-compose.yaml`, `ansible/inventory.yaml`, `ansible/push.yaml`, and `README.md`

## Tests and Acceptance

- [ ] Wrong-chain wallets cannot submit a payment until the supported chain is selected.
- [ ] Rejecting a chain switch sends no transfer and shows an actionable banner message.
- [ ] Network changes between sign-in and payment are detected.
- [ ] Browser amount/recipient/chain match effective server configuration.
- [ ] Mismatched RPC chain configuration fails visibly rather than silently accepting a different network.
- [ ] Browser tests cover default and non-default configuration without real transfers.
