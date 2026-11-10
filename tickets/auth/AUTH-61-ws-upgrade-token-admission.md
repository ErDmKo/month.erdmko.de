---
title: "WebSocket Upgrade Session Token & Paid-Access Admission"
ticket: "AUTH-61"
status: "completed"
draft: false
weight: 61
---

# AUTH-61 WebSocket Upgrade Session Token & Paid-Access Admission

**Priority: P0. Part of [AUTH-60](AUTH-60-authorized-room-broadcasts.md).**

## Depends on

- [AUTH-40](AUTH-40-ws-chat-enforcement.md)

## Goal

Admit `/ws/chat/{room_id}` WebSocket upgrades only when the request carries a valid `month_session` token belonging to a wallet with active paid access, and bind `ChatWs` directly to that verified `session_token`.

## Problem

`chat_ws_page_handler` in `server/src/pages/chat/mod.rs` currently resolves `month_session` optionally and falls back to `anon-{random}` when the cookie is missing, invalid, or expired. Even when a session exists, `chat_ws_page_handler` does not check `wallet_profiles.has_active_access` before upgrading the HTTP connection to a `ChatWs` actor, nor does it retain the `session_token` on `ChatWs` for subsequent token validation.

## Scope

- In `chat_ws_page_handler` (`server/src/pages/chat/mod.rs`):
  - Keep existing `Origin` header validation (`403 Forbidden` on missing/disallowed origin).
  - Require `extract_session_token(&req)` to return a non-empty `session_token`; otherwise reject the HTTP upgrade with `401 Unauthorized` (`UNAUTHORIZED`).
  - Resolve `get_valid_session_wallet(&conn, &session_token, now_unix)`; if `None`, reject the HTTP upgrade with `401 Unauthorized` (`UNAUTHORIZED`).
  - Load `get_wallet_profile(&conn, &wallet, now_unix)` and require `profile.has_active_access`; otherwise reject the HTTP upgrade with `403 Forbidden` (`PAYMENT_REQUIRED`).
  - Remove the `anon-{random}` fallback completely.
- In `ChatWs` (`server/src/pages/chat/chat_actor.rs`):
  - Store `pub(crate) session_token: String` alongside `pub(crate) sender_id: String` (the normalized wallet address).
  - Provide a helper on `ChatWs` to validate `self.session_token` against `auth_sessions` and `wallet_profiles` in SQLite (`get_valid_session_wallet` + `get_wallet_profile`).

## Implementation Areas

- `server/src/pages/chat/mod.rs`
- `server/src/pages/chat/chat_actor.rs`
- `server/src/pages/chat/tests/`

## Tests and Acceptance

- [x] `GET /ws/chat/{room_id}` without a `month_session` cookie is rejected at the HTTP upgrade with `401 Unauthorized`.
- [x] `GET /ws/chat/{room_id}` with an unknown, expired, or revoked `month_session` token is rejected at the HTTP upgrade with `401 Unauthorized`.
- [x] `GET /ws/chat/{room_id}` with a valid session token but unpaid or expired `wallet_profiles.access_until` is rejected at the HTTP upgrade with `403 Forbidden`.
- [x] `GET /ws/chat/{room_id}` with a valid session token and active paid access succeeds and initializes `ChatWs` with both `sender_id` and `session_token`.

## Result

**Status: DONE**

### Implemented modules
- `server/src/pages/chat/mod.rs` — enforces valid `month_session` cookie (`401 Unauthorized`) and active paid `WalletProfile` (`403 Forbidden`) before WebSocket upgrade, removes `anon-{random}` fallback, and initializes `ChatWs` with `sender_id` and `session_token`.
- `server/src/pages/chat/chat_actor.rs` — adds `session_token` field to `ChatWs` and `verify_session_and_access` helper validating `session_token` + wallet match + active paid access.
- `server/src/chat/messaging_actor.rs` — uses `ChatWs::verify_session_and_access` on `on_join`.
- `server/src/pages/chat/tests/messaging.rs` — tests missing, unknown, expired, and revoked sessions (`401`) and unpaid/expired paid access (`403` on upgrade, `PAYMENT_REQUIRED` if access expires before `Join`).
