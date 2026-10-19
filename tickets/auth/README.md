# Onchain Wallet Authentication & Paid Chat Access Tickets

Source: `tickets/chat-mvp/CHAT-80-onchain-auth-payments.md`

## Execution Order

1. `AUTH-10` Wallet Identity & Session Data Layer
2. `AUTH-20` SIWE Signature Verification & HTTP Session Endpoints
3. `AUTH-30` Onchain Access & Nickname Registry Contract + RPC Reader
4. `AUTH-40` WebSocket Chat Authentication & Ownership Enforcement
5. `AUTH-50` Browser Wallet Connect & SIWE UI

## Dependency Map

- `AUTH-10` → none
- `AUTH-20` → `AUTH-10`
- `AUTH-30` → `AUTH-10`
- `AUTH-40` → `AUTH-20`, `AUTH-30`
- `AUTH-50` → `AUTH-20`, `AUTH-40`

## Ticket Files

- `AUTH-10-identity-session-data-layer.md`
- `AUTH-20-siwe-verification-http.md`
- `AUTH-30-payment-nickname-contract.md`
- `AUTH-40-ws-chat-enforcement.md`
- `AUTH-50-browser-wallet-ui.md`

## Epics

### Epic 1: Offchain Identity, Nonces & Sessions
`AUTH-10`, `AUTH-20`

Establish normalized EVM wallet identities (`0x` + 40 lowercase hex chars), strict lowercase ASCII nickname validation (`[a-z0-9_-]{1,32}`), single-use expiring SIWE challenges in SQLite (`auth_nonces`), and server-verified sessions (`auth_sessions`) issued via `HttpOnly; Secure; SameSite=Lax` cookies after EIP-4361 signature verification.

### Epic 2: Onchain Payment & Nickname Ownership
`AUTH-30`

Define the `ChatAccessRegistry` smart contract (`accessUntil(address)`, `nicknameOf(address)`, `ownerOfNickname(string)`) and a read-only JSON-RPC client in Rust (`server/src/auth/rpc.rs`) querying the self-hosted EVM node.

### Epic 3: Chat Room & WebSocket Enforcement
`AUTH-40`, `AUTH-50`

Resolve the authenticated wallet session during `/ws/chat/{room_id}` upgrade, verify active paid access and authoritative onchain nickname before allowing room join, replace temporary `anon-*` sender IDs with the verified wallet address, enforce author-only message deletion, and wire EIP-1193 wallet login in the browser UI.

## Key Design Decisions

- **Identity**: Lowercase 20-byte EVM address (`0x` + 40 hex chars) is the canonical `sender_id` across chat, attachments, and voice.
- **No permanent `users` table**: Paid access expiration and nickname ownership live onchain; SQLite stores only ephemeral `auth_nonces`, `auth_sessions`, `rooms`, `messages`, and `attachments`.
- **Single-use nonces**: SIWE nonces expire after 5 minutes (`NONCE_TTL_SECS = 300`) and are atomically marked consumed on first verification to prevent replay attacks.
- **Session cookies**: Wallet signing happens once per session (`SESSION_TTL_SECS = 604800`, 7 days), not on every message or WebSocket reconnect.
- **Nickname safety**: Restricted to `1..=32` lowercase ASCII characters (`a-z`, `0-9`, `_`, `-`) to prevent Unicode homograph impersonation.
