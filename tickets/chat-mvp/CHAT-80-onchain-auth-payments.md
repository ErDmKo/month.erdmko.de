---
title: "Onchain Authentication and Paid Chat Access"
ticket: "CHAT-80"
status: "proposed"
draft: false
weight: 80
---

# CHAT-80 Onchain Authentication and Paid Chat Access

## Goal

Replace temporary anonymous chat identities with persistent wallet identities and grant chat access from an onchain payment contract, without an OAuth provider or payment processor.

## Proposed Design

- Use an EVM wallet address as the stable user ID.
- Authenticate with Sign-In with Ethereum (SIWE / EIP-4361): the server issues a short-lived, single-use nonce and verifies the wallet signature locally.
- Create a secure server session after authentication; wallet signing is not repeated for every message or reconnect.
- Read paid access and the authoritative nickname from a smart contract through the self-hosted blockchain node.
- Store chat messages, attachments, sessions, and temporary nonces offchain. Do not store private keys or seed phrases.
- Keep payment and nickname ownership onchain; a permanent `users` table is not required for the MVP.

## Contract Responsibilities

- Record paid access expiration for each wallet, for example `accessUntil(address)`.
- Assign each normalized nickname to at most one wallet.
- Return the nickname owned by a wallet.
- Support an explicit nickname change or transfer policy.

## Authentication Flow

1. Client requests a SIWE challenge from the server.
2. Server creates a cryptographically secure nonce with a short expiration.
3. Wallet signs a message containing the domain, URI, chain ID, nonce, issue time, and expiration.
4. Server verifies the message and signature, consumes the nonce, and creates an `HttpOnly`, `Secure`, `SameSite` session cookie.
5. The WebSocket upgrade resolves the session to the verified wallet address.
6. Server checks the contract for paid access and nickname ownership before allowing the user to join.
7. The verified wallet address replaces the current random `anon-*` sender ID; the client cannot choose the authoritative nickname.

## Security Requirements

- Reject reused, expired, wrong-domain, wrong-chain, or invalidly signed challenges.
- Never trust a wallet address or nickname supplied without signature verification.
- Separate authentication from authorization: a valid signature does not itself prove paid access.
- Use HTTPS/WSS in production and normalize wallet addresses consistently.
- Restrict nickname syntax initially to a simple lowercase ASCII format to avoid Unicode impersonation.
- Consider EIP-1271 support for smart-contract wallets.

## Tradeoffs

- Authentication signatures are free and fast because login is not an onchain transaction.
- The paying wallet, chat identity, and nickname owner are the same identity, avoiding a Google-account-to-wallet linking table.
- Users need a wallet and wallet recovery is harder than Google account recovery.
- Wallet addresses and onchain nickname/payment relationships are public and one person can control multiple wallets.

## Out of Scope

- Storing chat messages onchain.
- Requiring an onchain transaction for every message.
- Custody of user funds or wallet keys.
- Google OAuth or another identity provider.
- Proving that one wallet represents one unique human.

## Acceptance Criteria

- The same wallet has the same chat identity after reconnecting.
- Another wallet cannot claim an already registered nickname.
- Unauthenticated or unpaid wallets cannot join the paid chat.
- A successful login requires no gas and no third-party authentication service.
- WebSocket messages use the server-verified wallet address and contract-provided nickname.
- Message ownership can be enforced using the persistent wallet sender ID.
