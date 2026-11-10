---
title: "Token & Joined-Room Guards for Direct WS Actions and Attachments"
ticket: "AUTH-63"
status: "completed"
draft: false
weight: 63
---

# AUTH-63 Token & Joined-Room Guards for Direct WS Actions and Attachments

**Priority: P0. Part of [AUTH-60](AUTH-60-authorized-room-broadcasts.md).**

## Depends on

- [AUTH-61](AUTH-61-ws-upgrade-token-admission.md)
- [AUTH-62](AUTH-62-room-registry-join-membership.md)

## Goal

Require both a completed room join and a currently valid `session_token` with active paid access for every direct WebSocket client action, including attachment uploads/downloads, message deletion, and voice signaling.

## Problem

While `on_message` and `on_voice_join` check `self.session.sender_name()`, `on_delete`, `on_upload_start`, `UploadChunk`, `on_upload_end`, and `on_download_request` do not verify that the client has joined the room or that `self.session_token` and paid access are still valid. An unjoined connection can request attachment downloads (`DownloadRequest`) or initiate uploads (`UploadStart`) directly.

## Scope

- Implement a shared token-and-join verification helper on `ChatWs` (e.g., `verify_member_token_and_join(&mut self, request_id: Option<&str>, ctx: &mut ws::WebsocketContext<Self>) -> bool`):
  - Check that `self.session.sender_name().is_some()` (the client has joined the room); if not, send `VALIDATION_ERROR` (`"Join the room before performing this action."`).
  - Verify `self.session_token` via `get_valid_session_wallet(&conn, &self.session_token, now_unix)` matches `self.sender_id` and `get_wallet_profile(&conn, &self.sender_id, now_unix)` has `has_active_access == true`.
- Guard all non-join frame handlers with this check:
  - `on_message` and `on_delete` (`server/src/chat/messaging_actor.rs`)
  - `on_upload_start`, `UploadChunk`, `on_upload_end`, and `on_download_request` (`server/src/chat/attachments_actor.rs` and `server/src/pages/chat/dispatch.rs`)
  - `on_voice_join`, `on_voice_offer`, and `on_voice_ice` (`server/src/voice/voice_actor.rs`)
- In `on_upload_start` / `persist_upload` (`server/src/chat/attachments_actor.rs`, `server/src/attachments/db.rs`):
  - Ensure the target `message_id` belongs to `self.room_id` and was authored by `self.sender_id` before accepting or persisting an attachment.

## Implementation Areas

- `server/src/pages/chat/chat_actor.rs`
- `server/src/pages/chat/dispatch.rs`
- `server/src/chat/messaging_actor.rs`
- `server/src/chat/attachments_actor.rs`
- `server/src/attachments/db.rs` and `server/src/attachments/service.rs`
- `server/src/voice/voice_actor.rs`
- `server/src/pages/chat/tests/`

## Tests and Acceptance

- [x] Unjoined WebSocket clients cannot download attachments (`DownloadRequest`), start/finish uploads, delete messages, or send voice signaling frames.
- [x] A client cannot attach a file to a message authored by a different wallet or in a different room.
- [x] All direct requests (`Message`, `Delete`, `UploadStart`, `UploadChunk`, `UploadEnd`, `DownloadRequest`, `Voice*`) fail when the connection's `session_token` is revoked/expired or paid access has expired.

## Result

**Status: DONE**

### Implemented modules
- `server/src/pages/chat/chat_actor.rs` — added `verify_active_token` and `require_joined_member` helpers on `ChatWs`, revoking room broadcast membership immediately if `UNAUTHORIZED` or `PAYMENT_REQUIRED` is detected.
- `server/src/attachments/db.rs` — added `is_message_owned_by_sender_in_room` to verify message room + author wallet ownership before accepting uploads.
- `server/src/chat/messaging_actor.rs`, `server/src/chat/attachments_actor.rs`, `server/src/pages/chat/dispatch.rs`, `server/src/voice/voice_actor.rs` — guarded `on_message`, `on_delete`, `on_upload_start`, `UploadChunk`, `on_upload_end`, `on_download_request`, `on_voice_join`, `on_voice_offer`, and `on_voice_ice`.
- `server/src/pages/chat/tests/attachments.rs` — added tests for unjoined attachment download/upload rejection, cross-wallet/cross-room attachment upload rejection, and direct action rejection after paid-access expiry or session revocation.
