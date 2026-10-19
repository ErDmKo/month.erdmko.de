---
title: "WebSocket Chat Authentication & Ownership Enforcement"
ticket: "AUTH-40"
status: "pending"
draft: false
weight: 40
---

# AUTH-40 WebSocket Chat Authentication & Ownership Enforcement

## Depends on
- `AUTH-20`
- `AUTH-30`

## Goal
Bind `/ws/chat/{room_id}` connections to the verified wallet session, enforce paid onchain access and contract-assigned nicknames on room join, and restrict message deletion to the message author's wallet.

## Scope

### WebSocket upgrade & join enforcement
- In `chat_ws_page_handler` (`server/src/pages/chat/mod.rs`):
  - Resolve the `month_session` cookie via `auth::db::get_valid_session_wallet`.
  - Set `ChatWs.sender_id` to the verified lowercase wallet address instead of `anon-{random}`.
- In `ChatWs::on_join` (`server/src/chat/messaging_actor.rs`):
  - Query `AccessVerifier` for `self.sender_id`.
  - Reject unpaid or expired wallets with `ACCESS_DENIED` (`ServerError`).
  - Use the authoritative onchain nickname from the contract (ignoring client-supplied nickname spoofing).

### Message deletion ownership (`server/src/chat/db.rs` & `messaging_actor.rs`)
- Update `delete_message_by_id` to require `sender_id = ?3` so a user can only delete messages authored by their own wallet address.

## Deliverables
- `server/src/pages/chat/mod.rs` — session-backed wallet `sender_id` on WS upgrade
- `server/src/chat/messaging_actor.rs` — onchain access & nickname check on join, sender ownership check on delete
- `server/src/chat/db.rs` — author-scoped `delete_message_by_id`

## Tests
- Integration: reconnecting with the same session cookie preserves the exact wallet `sender_id`.
- Integration: unpaid wallet is rejected on join with `ACCESS_DENIED`.
- Integration: wallet A cannot delete wallet B's message (`VALIDATION_ERROR`).

## Acceptance
- WebSocket messages and voice participants use the server-verified wallet address and contract-provided nickname.
- Message deletion is strictly author-only.
