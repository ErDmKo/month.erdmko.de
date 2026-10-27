---
title: "Browser Wallet (window.ethereum) Connect, SIWE & Payment UI"
ticket: "AUTH-50"
status: "pending"
draft: false
weight: 50
---

# AUTH-50 Browser Wallet (`window.ethereum`) Connect, SIWE & Payment UI

## Depends on
- `AUTH-20`
- `AUTH-30`

## Goal
Add native `window.ethereum` (EIP-1193) wallet connect, free SIWE signature login (`personal_sign`), and one-click ETH payment (`eth_sendTransaction` to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c`) to the chat welcome screen, following `assets/js/CODESTYLE.md` (`ctx: Window`, `Task` pipelines, `TupleOf` / `ReadonlyTupleOf`, declarative DOM, zero external SDK dependencies).

## Scope

### Wallet, SIWE & Payment Tasks (`assets/js/chat/auth/`)
- `requestAccountsTask(ctx: Window): Task<string>` — wraps `ctx.ethereum.request({ method: 'eth_requestAccounts' })`.
- `fetchNonceTask(ctx: Window, walletAddress: string): Task<NonceChallenge>` — calls `POST /auth/nonce`.
- `signSiweMessageTask(ctx: Window, walletAddress: string, message: string): Task<string>` — wraps `ctx.ethereum.request({ method: 'personal_sign', params: [message, walletAddress] })`.
- `verifySiweTask(ctx: Window, message: string, signature: string): Task<SessionStatus>` — calls `POST /auth/verify`.
- `sendPaymentTransactionTask(ctx: Window, fromWallet: string, toWallet: string, valueHex: string): Task<string>` — wraps `ctx.ethereum.request({ method: 'eth_sendTransaction', ... })` returning `txHash`.
- `claimPaymentTask(ctx: Window, txHash: string, nickname: string): Task<SessionStatus>` — calls `POST /auth/claim-payment`.

### UI flow (`assets/js/chat/chat-ui/`)
1. **Disconnected**: Show **Connect Wallet** button (or a clear message if `ctx.ethereum` is not available).
2. **Connected but Unpaid**: Show connected wallet address, nickname input (`[a-z0-9_-]{1,32}`), and **Pay & Unlock Chat** button that triggers `eth_sendTransaction` to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c` and claims the `txHash`.
3. **Connected & Paid (`hasActiveAccess: true`)**: Show connected wallet, active expiration date, and **Join Room** button.

## Deliverables
- `assets/js/chat/auth/index.ts`, `wallet.ts`, `api.ts`
- Updated `assets/js/chat/chat-ui/template.ts` and `join-form-handler.ts`
- Unit tests in `assets/js/chat/auth/auth.test.ts`

## Tests
- Unit: `Task` pipeline tests with mocked `ctx.ethereum` and `ctx.fetch` covering connect → sign → payment → claim → join.
- Manual: connect browser wallet, sign SIWE prompt, send payment, join room, refresh page, confirm session and nickname persist.

## Acceptance
- Zero external npm runtime dependencies added to the bundle.
- Strictly follows `assets/js/CODESTYLE.md` (`ctx: Window`, `Task` pipelines, `TupleOf` / `ReadonlyTupleOf`, declarative DOM).
