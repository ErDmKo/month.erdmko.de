---
title: "Onchain Access & Nickname Registry Contract + RPC Reader"
ticket: "AUTH-30"
status: "pending"
draft: false
weight: 30
---

# AUTH-30 Onchain Access & Nickname Registry Contract + RPC Reader

## Depends on
- `AUTH-10`

## Goal
Define the Solidity contract for paid chat access and unique nickname ownership, and implement a read-only EVM JSON-RPC client in Rust that queries access expiration and nickname for a verified wallet.

## Scope

### Smart Contract (`contracts/auth/ChatAccessRegistry.sol`)
- `accessUntil(address wallet) external view returns (uint64)` — unix timestamp until which `wallet` has paid chat access.
- `nicknameOf(address wallet) external view returns (string memory)` — authoritative lowercase ASCII nickname owned by `wallet`.
- `ownerOfNickname(string calldata nickname) external view returns (address)` — reverse lookup ensuring at most one wallet owns each normalized nickname.
- `buyAccess(string calldata nickname) external payable` — extends access and optionally claims/updates nickname if available and valid (`[a-z0-9_-]{1,32}`).
- `setNickname(string calldata nickname) external` — updates nickname for an already-active wallet, releasing the previous nickname.

### Server RPC Reader (`server/src/auth/rpc.rs`)
- Configurable via `ETH_RPC_URL` and `CHAT_ACCESS_CONTRACT_ADDRESS`.
- `get_wallet_access(wallet_address: &str) -> AuthResult<WalletAccessStatus>`:
  - Calls `accessUntil(address)` and `nicknameOf(address)` via `eth_call`.
  - Validates the returned nickname with `validate_ascii_nickname`.
  - Returns `{ has_active_access: bool, access_until: u64, nickname: Option<String> }`.
- Trait-based abstraction (`AccessVerifier`) so unit/integration tests can use an in-memory mock without a live node.

## Deliverables
- `contracts/auth/ChatAccessRegistry.sol`
- `server/src/auth/rpc.rs` with `AccessVerifier` trait + JSON-RPC implementation

## Tests
- Unit: ABI calldata encoding for `accessUntil(address)` and `nicknameOf(address)` and ABI response decoding.
- Unit: mock `AccessVerifier` verifies paid/unpaid expiration boundary and nickname normalization.

## Acceptance
- Server reads authoritative nickname and paid status from the contract interface without requiring a `users` table in SQLite.
