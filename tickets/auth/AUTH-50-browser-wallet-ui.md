---
title: "Browser Wallet Connect & SIWE UI"
ticket: "AUTH-50"
status: "pending"
draft: false
weight: 50
---

# AUTH-50 Browser Wallet Connect & SIWE UI

## Depends on
- `AUTH-20`
- `AUTH-40`

## Goal
Replace the anonymous nickname input on the chat welcome screen with a "Connect Wallet & Sign In" flow using `ctx.ethereum` (EIP-1193), adhering strictly to `assets/js/CODESTYLE.md` (`ctx: Window`, `Task` pipelines, named tuple indices, declarative DOM).

## Scope

### Wallet & SIWE Tasks (`assets/js/chat/auth/`)
- `requestAccountsTask(ctx: Window): Task<string>` — wraps `ctx.ethereum.request({ method: 'eth_requestAccounts' })`.
- `fetchNonceTask(ctx: Window, walletAddress: string): Task<NonceResponse>` — calls `POST /auth/nonce`.
- `signSiweMessageTask(ctx: Window, walletAddress: string, message: string): Task<string>` — wraps `personal_sign`.
- `verifySiweTask(ctx: Window, message: string, signature: string): Task<SessionInfo>` — calls `POST /auth/verify`.

### UI integration (`assets/js/chat/chat-ui/`)
- Show connected wallet address and onchain nickname status on the welcome screen.
- Automatically join or enable room entry once the session cookie is active.
- Display clear user-facing errors when no EIP-1193 wallet is installed, signature is rejected, or onchain access is unpaid.

## Deliverables
- `assets/js/chat/auth/index.ts`, `wallet.ts`, `siwe.ts`
- Updated `assets/js/chat/chat-ui/template.ts` and `join-form-handler.ts`
- Unit tests in `assets/js/chat/auth/auth.test.ts`

## Tests
- Unit: SIWE message formatting and `Task` pipeline composition with mocked `ctx.ethereum` and `ctx.fetch`.
- Manual: connect browser wallet, sign SIWE prompt once, refresh page, confirm session persists without re-signing.

## Acceptance
- Follows all rules in `assets/js/CODESTYLE.md` (explicit `ctx`, `Task` pipelines, named tuple indices, no `async`/`await`).
