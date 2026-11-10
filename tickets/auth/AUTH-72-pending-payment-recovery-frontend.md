---
title: "Pending Payment Persistence, Protobuf Claim Polling & Resume UI (Frontend)"
ticket: "AUTH-72"
status: "completed"
draft: false
weight: 72
---

# AUTH-72 Pending Payment Persistence, Protobuf Claim Polling & Resume UI (Frontend)

**Priority: P0. Part of [AUTH-70](AUTH-70-pending-payment-recovery.md).**

## Depends on

- [AUTH-50](AUTH-50-browser-wallet-ui.md)
- [AUTH-71](AUTH-71-protobuf-payment-claim-backend.md)
- Coordinate chain/payment config with [AUTH-80](AUTH-80-payment-network-consistency.md).

## Goal

Persist the transaction hash returned by `eth_sendTransaction` before claiming, decode `.proto`-generated numeric claim outcomes in the browser, poll pending confirmations with bounded backoff, and resume pending payments across retries, nickname edits, and page reloads without ever requesting a second transfer.

## Problem

`payAndClaimTask` in `assets/js/chat/auth/index.ts` chains `sendPaymentTransactionTask` directly into `claimPaymentTask` without saving the returned `txHash`. When the transaction is still in the mempool (or if a nickname conflict or page reload happens), the `txHash` is lost and clicking **Pay & Unlock Chat** triggers a second `eth_sendTransaction` transfer in the user's wallet.

## Scope

- **Pending transaction storage (`assets/js/chat/auth/`)**:
  - Immediately after `sendPaymentTransactionTask` resolves with `txHash`, persist a tuple in `localStorage` associated with `{ walletAddress, chainId, toWallet, valueHex, txHash }` **before** sending `/auth/claim-payment`.
  - Provide helpers to load, match, and clear the stored pending transaction for the active wallet and payment configuration.
- **Protobuf claim client & bounded polling (`assets/js/chat/auth/api.ts`, `index.ts`)**:
  - Encode/decode `/auth/claim-payment` using the `.proto`-generated functions and numeric `oneof` variant constants from `AUTH-71` (zero string error code comparisons).
  - When `/auth/claim-payment` returns the numeric `Pending` variant:
    - Transition UI state to pending confirmation and retry `/auth/claim-payment` with bounded backoff using the **same** `txHash`.
  - When `/auth/claim-payment` returns `NicknameTaken`:
    - Keep the stored `txHash` intact and prompt the user to choose another nickname; clicking the action button re-claims the existing `txHash` with the new nickname without calling `eth_sendTransaction`.
  - When `/auth/claim-payment` returns `Activated` (or `fetchSessionTask` shows `hasActiveAccess == true`):
    - Clear the stored pending `txHash` and transition to the authorized room state.
  - When `/auth/claim-payment` returns a terminal transaction failure (`Reverted`, `InvalidTransaction`):
    - Clear the stored pending `txHash` and display an actionable error in the onboarding banner so the user can initiate a fresh payment if desired.
- **Onboarding UI & refresh recovery (`assets/js/chat/chat-ui/onboarding.ts`, `join-form-handler.ts`)**:
  - Restore any stored pending `txHash` for the connected wallet on `/chat` initialization, reconnect, or page refresh, displaying the pending `txHash` and block explorer link and allowing one-click resume/polling without sending a new transfer.

## Implementation Areas

- `assets/js/chat/auth/api.ts`, `index.ts`, and `wallet.ts`
- `assets/js/chat/chat-ui/onboarding.ts`, `join-form-handler.ts`, and `state.ts`
- `assets/js/chat/auth/auth.test.ts` and `assets/js/chat/chat-ui/chat-ui.test.ts`

## Tests and Acceptance

- [x] Pending $\rightarrow$ poll/retry $\rightarrow$ confirmed sends **exactly one** `eth_sendTransaction` request.
- [x] Refreshing or reconnecting while a payment is pending restores the saved `txHash` and resumes claiming without calling `eth_sendTransaction`.
- [x] `NicknameTaken` preserves the pending `txHash`; editing the nickname and submitting claims the original transaction.
- [x] Terminal onchain failure (`Reverted` / `InvalidTransaction`) clears the saved `txHash` and surfaces an actionable error.
- [x] All frontend claim status branching uses `.proto`-generated numeric constants rather than string error codes.

## Result

**Status: DONE**

### Implemented modules
- `assets/js/chat/auth/api.ts` — implemented `claimPaymentProtoTask`, `activatedToSessionStatus`, and `claimPaymentOutcomeMessage` using `.proto`-generated binary `encodeClaimPaymentRequest` / `decodeClaimPaymentResponse` and numeric `CLAIM_PAYMENT_RESPONSE_*` constants.
- `assets/js/chat/auth/index.ts` — implemented `savePendingPaymentTx`, `loadPendingPaymentTx`, `clearPendingPaymentTx`, `pollClaimPaymentTask`, and updated `payAndClaimTask` so `txHash` is persisted in `localStorage` immediately before `/auth/claim-payment`, reused on `Pending` / `NicknameTaken` / page reloads, recovered via `fetchSessionTask` on lost HTTP responses, and cleared on `Activated`, `Reverted`, or `InvalidTransaction`.
- `assets/js/chat/chat-ui/state.ts`, `join-form-handler.ts`, `onboarding.ts` — added `CHAT_UI_STATE_PENDING_TX_HASH`, restored pending transaction state in `applySessionStatusToState` and `initChatOnboarding`, and rendered the pending transaction notice and Etherscan link in `onboardingTemplate`.
- `assets/js/chat/auth/auth.test.ts` & `assets/js/chat/chat-ui/chat-ui.test.ts` — verified single-transfer polling, `NicknameTaken` retry reuse, `Reverted` / `InvalidTransaction` cleanup, lost HTTP response recovery, and onboarding UI restoration.
