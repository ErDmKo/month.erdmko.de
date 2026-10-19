---
title: "Wallet Authentication and Paid Chat Access"
ticket: "CHAT-80"
status: "in_progress"
draft: false
weight: 80
---

# CHAT-80 Wallet Authentication and Paid Chat Access

## Goal

Replace temporary anonymous chat identities with persistent EVM wallet identities (`window.ethereum` / EIP-1193) and gate paid features behind a direct ETH payment to the project wallet (`0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c`), without an OAuth provider, payment processor, Solidity smart contract deployment, or self-hosted blockchain node.

## Architecture & Design

- **Browser Wallet Connect (`window.ethereum` / EIP-1193)**:
  - Zero third-party SDKs or WalletConnect Cloud API keys; uses native `eth_requestAccounts`, `personal_sign`, and `eth_sendTransaction` via the project's `Task` pipeline and explicit `ctx: Window`.
- **Local SIWE Authentication (EIP-4361 / EIP-191)**:
  - The server issues a short-lived, single-use nonce (`auth_nonces` in SQLite) and verifies the wallet's `personal_sign` signature locally using `Keccak-256` + `secp256k1` `ecrecover` (zero RPC calls and zero gas to sign in).
  - Creates an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie (`auth_sessions` in SQLite) so wallet signing is not repeated on every message or reconnect.
- **Direct ETH Payment + Single Public RPC Verification**:
  - To unlock paid access, the user sends ETH directly to the recipient wallet (`0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c`) via `eth_sendTransaction`, producing a transaction hash (`txHash`).
  - The server verifies `txHash` once against a configured public HTTPS JSON-RPC endpoint (`ETH_RPC_URL`) using `eth_getTransactionByHash` and `eth_getTransactionReceipt`:
    - `receipt.status == "0x1"` (confirmed onchain)
    - `tx.to == RECIPIENT_WALLET_ADDRESS`
    - `tx.from == session.wallet_address`
    - `tx.value >= MIN_PAYMENT_WEI`
    - `txHash` has not been claimed before (`claimed_payments` table in SQLite).
  - Once verified, SQLite records the payment in `claimed_payments` and extends `access_until` in `wallet_profiles`.
- **Offchain SQLite Profile & Unique Nickname Ownership**:
  - `wallet_profiles` in SQLite maps each normalized `wallet_address` to its unique normalized ASCII `nickname` (`[a-z0-9_-]{1,32}`) and `access_until` timestamp.
  - Every subsequent chat join, message, attachment upload, or voice call checks `wallet_profiles` locally in SQLite with zero ongoing RPC calls.

## Protocol & Storage Responsibilities (`contracts/chat/chat.proto` + SQLite)

- **`auth_nonces` (SQLite)**: Single-use expiring SIWE challenge nonces per wallet.
- **`auth_sessions` (SQLite)**: Active session tokens bound to a verified wallet address.
- **`wallet_profiles` (SQLite)**:
  - `wallet_address` (`0x` + 40 lowercase hex chars, `PRIMARY KEY`)
  - `nickname` (`UNIQUE`, lowercase ASCII `[a-z0-9_-]{1,32}`)
  - `access_until` (unix timestamp until which paid features are unlocked)
- **`claimed_payments` (SQLite)**:
  - `tx_hash` (`0x` + 64 lowercase hex chars, `PRIMARY KEY`) preventing replay of any payment transaction.
  - `wallet_address`, `amount_wei`, `claimed_at`.

## Authentication & Payment Flow

1. Client connects browser wallet via `ctx.ethereum.request({ method: 'eth_requestAccounts' })`.
2. Client requests a SIWE challenge nonce from the server (`POST /auth/nonce`).
3. Wallet signs the challenge with `personal_sign` (free, offchain, no gas).
4. Server verifies the signature (`ecrecover`), consumes the single-use nonce, and sets an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie (`POST /auth/verify`).
5. If the wallet's `access_until` is expired, the user clicks **Unlock Access**, sending ETH to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c` via `eth_sendTransaction` and submitting the `txHash` (`POST /auth/claim-payment`).
6. Server verifies the transaction receipt via `ETH_RPC_URL`, records `tx_hash` in `claimed_payments`, and extends `access_until` in `wallet_profiles`.
7. On `/ws/chat/{room_id}` upgrade and room join, the server resolves the session cookie to the verified wallet address, checks `wallet_profiles` for active access and unique nickname ownership, and uses the wallet address as the authoritative `sender_id`.

## Security Requirements

- Reject reused, expired, wrong-domain, wrong-chain, or invalidly signed SIWE challenges.
- Reject replayed `txHash` values, failed transactions (`status != 0x1`), wrong recipient address, wrong sender address, or underpaid amounts.
- Never trust a wallet address or nickname supplied without signature verification.
- Separate authentication (valid SIWE session) from authorization (`access_until > now`).
- Normalize all wallet addresses (`0x` + 40 lowercase hex) and transaction hashes (`0x` + 64 lowercase hex).
- Restrict nickname syntax to lowercase ASCII `[a-z0-9_-]{1,32}` to prevent Unicode homograph impersonation.
- Never store or accept private keys or seed phrases.

## Out of Scope

- Deploying or maintaining a Solidity smart contract.
- Running a self-hosted Ethereum node on the VPS.
- Bundling heavy third-party wallet SDKs (WalletConnect v2 QR modal, wagmi, ethers.js).
- Storing chat messages onchain or requiring a transaction per message.
- Google OAuth or another third-party identity provider.

## Acceptance Criteria

- The same wallet has the same chat identity (`sender_id`) and nickname after reconnecting.
- Another wallet cannot claim an already registered nickname (`NICKNAME_TAKEN`).
- Unauthenticated or unpaid wallets cannot access paid chat features.
- A successful login requires zero gas, zero RPC calls, and no third-party authentication service.
- Each payment `txHash` can only be claimed once and must pay `>= MIN_PAYMENT_WEI` to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c`.
- Message deletion is enforced using the persistent wallet `sender_id`.

## Breakdown & Execution Track

Detailed implementation tickets are tracked in `tickets/auth/README.md`:

1. `AUTH-10` Wallet Identity, Profile, Payment & Session Data Layer (`completed`)
2. `AUTH-20` SIWE Signature Verification & HTTP Session Endpoints (`pending`)
3. `AUTH-30` Direct ETH Payment Receipt Verification via Public RPC (`pending`)
4. `AUTH-40` WebSocket Chat Authentication & Ownership Enforcement (`pending`)
5. `AUTH-50` Browser Wallet (`window.ethereum`) Connect, SIWE & Payment UI (`pending`)
