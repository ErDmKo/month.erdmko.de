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
- `AUTH-50`

## Goal
Bind `/ws/chat/{room_id}` connections to the verified wallet session, enforce active paid access and unique nickname from SQLite (`wallet_profiles`) on room join, and restrict message deletion to the message author's wallet.

## Scope

### WebSocket upgrade & join enforcement
- In `chat_ws_page_handler` (`server/src/pages/chat/mod.rs`):
  - Resolve the `month_session` cookie via `auth::db::get_valid_session_wallet`.
  - Set `ChatWs.sender_id` to the verified lowercase wallet address.
- In `ChatWs::on_join` (`server/src/chat/messaging_actor.rs`):
  - Load `WalletProfile` from `auth::db::get_wallet_profile`.
  - Reject unpaid or expired wallets (`!profile.has_active_access`) with `PAYMENT_REQUIRED` (`ServerError`).
  - If the client supplies a nickname on join (or already has one in `wallet_profiles`), persist/verify ownership via `set_wallet_nickname` so no two wallets can use the same nickname (`NICKNAME_TAKEN`).

### Message deletion ownership (`server/src/chat/db.rs` & `messaging_actor.rs`)
- Update `delete_message_by_id` to require `sender_id = ?3` so a user can only delete messages authored by their own wallet address.

## Deliverables
- `server/src/pages/chat/mod.rs` — session-backed wallet `sender_id` on WS upgrade
- `server/src/chat/messaging_actor.rs` — SQLite `wallet_profiles` access & nickname check on join, sender ownership check on delete
- `server/src/chat/db.rs` — author-scoped `delete_message_by_id`

## Tests
- Integration: reconnecting with the same session cookie preserves the exact wallet `sender_id` and nickname.
- Integration: unpaid wallet is rejected on join with `PAYMENT_REQUIRED`.
- Integration: second wallet attempting to claim an already-taken nickname receives `NICKNAME_TAKEN`.
- Integration: wallet A cannot delete wallet B's message.

## Acceptance
- WebSocket messages, attachments, and voice participants use the server-verified wallet address and unique SQLite-backed nickname.
- Message deletion is strictly author-only.
