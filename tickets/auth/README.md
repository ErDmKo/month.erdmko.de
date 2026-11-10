# Wallet Authentication & Paid Chat Access Tickets

Source: `tickets/chat-mvp/CHAT-80-onchain-auth-payments.md`

## Open Deployment Blockers

The 2026-11-06 review of `89bf688` found gaps in the completed authentication work.
The follow-up tickets track the fixes; see the [deployment backlog](../deployment/README.md) for release verification.

| Ticket | Priority | Goal |
| --- | --- | --- |
| [AUTH-60](AUTH-60-authorized-room-broadcasts.md) | P0 | Authenticate room broadcast recipients (umbrella) |
| ↳ [AUTH-61](AUTH-61-ws-upgrade-token-admission.md) | P0 | WebSocket upgrade session token & paid-access admission |
| ↳ [AUTH-62](AUTH-62-room-registry-join-membership.md) | P0 | Separate connection slots from post-join broadcast recipients |
| ↳ [AUTH-63](AUTH-63-direct-action-token-guards.md) | P0 | Token & joined-room guards for direct WS actions and attachments |
| ↳ [AUTH-64](AUTH-64-session-revocation-access-expiry.md) | P0 | Live session revocation, paid-access expiry & client redirect |
| [AUTH-70](AUTH-70-pending-payment-recovery.md) | P0 | Resume payment confirmation without a second transfer (umbrella) |
| ↳ [AUTH-71](AUTH-71-protobuf-payment-claim-backend.md) | P0 | Protobuf payment claim contract & typed verification states (backend) |
| ↳ [AUTH-72](AUTH-72-pending-payment-recovery-frontend.md) | P0 | Pending payment persistence, protobuf claim polling & resume UI (frontend) |
| [AUTH-80](AUTH-80-payment-network-consistency.md) | P1 | Enforce the supported payment network |
| [AUTH-90](AUTH-90-atomic-payment-activation.md) | P1 | Commit payment and access activation atomically |

## Execution Order

1. `AUTH-10` Wallet Identity, Profile, Payment & Session Data Layer
2. `AUTH-20` SIWE Signature Verification & HTTP Session Endpoints
3. `AUTH-30` Direct ETH Payment Receipt Verification via Public RPC
4. `AUTH-50` Browser Wallet (`window.ethereum`) Connect, SIWE & Payment UI
5. `AUTH-40` WebSocket Chat Authentication & Ownership Enforcement

## Dependency Map

- `AUTH-10` → none
- `AUTH-20` → `AUTH-10`
- `AUTH-30` → `AUTH-10`, `AUTH-20`
- `AUTH-50` → `AUTH-20`, `AUTH-30`
- `AUTH-40` → `AUTH-20`, `AUTH-30`, `AUTH-50`

## Ticket Files

- `AUTH-10-identity-session-data-layer.md`
- `AUTH-20-siwe-verification-http.md`
- `AUTH-30-payment-nickname-contract.md`
- `AUTH-40-ws-chat-enforcement.md`
- `AUTH-50-browser-wallet-ui.md`
- `AUTH-60-authorized-room-broadcasts.md`
- `AUTH-61-ws-upgrade-token-admission.md`
- `AUTH-62-room-registry-join-membership.md`
- `AUTH-63-direct-action-token-guards.md`
- `AUTH-64-session-revocation-access-expiry.md`
- `AUTH-70-pending-payment-recovery.md`
- `AUTH-71-protobuf-payment-claim-backend.md`
- `AUTH-72-pending-payment-recovery-frontend.md`
- `AUTH-80-payment-network-consistency.md`
- `AUTH-90-atomic-payment-activation.md`

## Epics

### Epic 1: Offchain Identity, Profiles, Nonces & Sessions
`AUTH-10`, `AUTH-20`

Establish normalized EVM wallet identities (`0x` + 40 lowercase hex chars), normalized transaction hashes (`0x` + 64 lowercase hex chars), strict lowercase ASCII nickname validation (`[a-z0-9_-]{1,32}`), SQLite tables (`auth_nonces`, `auth_sessions`, `wallet_profiles`, `claimed_payments`), and local EIP-4361 / EIP-191 (`personal_sign`) signature verification issuing `HttpOnly; Secure; SameSite=Lax` session cookies.

### Epic 2: Direct ETH Payment Verification (No Smart Contract / No Self-Hosted Node)
`AUTH-30`

Verify direct ETH transfers to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c` via a single read-only JSON-RPC check (`eth_getTransactionByHash` + `eth_getTransactionReceipt`) against a public HTTPS RPC URL (`ETH_RPC_URL`), record the claimed `txHash` in SQLite (`claimed_payments`), and extend `access_until` in `wallet_profiles`.

### Epic 3: Chat Room Enforcement & Browser `window.ethereum` UI
`AUTH-40`, `AUTH-50`

Resolve the authenticated wallet session during `/ws/chat/{room_id}` upgrade, check `wallet_profiles` in SQLite for active paid access and unique nickname ownership, replace temporary `anon-*` sender IDs with the verified wallet address, enforce author-only message deletion, and wire native `window.ethereum` (EIP-1193) login + payment in `assets/js/chat/`.

## Key Design Decisions

- **Browser wallet**: Native `window.ethereum` (EIP-1193) — zero external JS dependencies, zero WalletConnect Cloud API keys, minimal bundle size.
- **No Solidity smart contract**: Users pay ETH directly to `0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c` (lowest 21,000 gas transfer, zero contract deployment/maintenance).
- **No self-hosted blockchain node**: Sign-in (`personal_sign` `ecrecover`) is 100% local math; payment verification makes one HTTPS JSON-RPC call per `txHash` to a public RPC endpoint (`ETH_RPC_URL`) and caches `access_until` in SQLite.
- **Unique nicknames & replay protection in SQLite**: `wallet_profiles` enforces unique lowercase ASCII nicknames (`[a-z0-9_-]{1,32}`) and `claimed_payments` prevents claiming any `txHash` more than once.
