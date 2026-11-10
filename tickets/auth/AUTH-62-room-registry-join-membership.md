---
title: "Separate Connection Slots from Post-Join Broadcast Recipients"
ticket: "AUTH-62"
status: "completed"
draft: false
weight: 62
---

# AUTH-62 Separate Connection Slots from Post-Join Broadcast Recipients

**Priority: P0. Part of [AUTH-60](AUTH-60-authorized-room-broadcasts.md).**

## Depends on

- [AUTH-61](AUTH-61-ws-upgrade-token-admission.md)

## Goal

Decouple global open-connection accounting from room broadcast membership so a WebSocket connection only receives room broadcasts after completing a verified `Join` with a valid session token and active paid access.

## Problem & Architectural Motivation

`RoomRegistry<ChatWs>` in `server/src/chat/service.rs` currently conflates two different layers into a single per-room `Vec<Addr<ChatWs>>` populated in `ChatWs::started`:

1. **Transport-level connection accounting** (`MAX_OPEN_CONNECTIONS` DoS protection for open WebSocket connections).
2. **Application-level room pub/sub membership** (which connections have completed `ClientJoin` for a room).

### Why an open WebSocket is not yet a room member

- **Historical background ([CHAT-30](../chat-mvp/CHAT-30-ws-room-hub.md) / [CHAT-40](../chat-mvp/CHAT-40-chat-page-ui.md) $\rightarrow$ [AUTH-50](AUTH-50-browser-wallet-ui.md))**:
  - In the original pre-auth MVP (`CHAT-30` and `CHAT-40`), there was no `/chat` onboarding page or wallet session. Opening `/chat/{room_id}` immediately opened the WebSocket (`connectWs()`) while the user was still looking at the nickname form, and the socket sat open waiting until the user typed a nickname and clicked **Join** (`ClientJoin`).
  - When wallet authentication (`AUTH-50`) was introduced, `fetchSessionTask(ctx)` (`GET /auth/session`) was added to `assets/js/chat/chat-ui/init.ts` alongside the existing immediate `connectWs()` call. As a result, both `GET /auth/session` and `new WebSocket(...)` run in parallel on page load rather than sequentially, and `tryAutoJoin` is called in both callbacks (`fetchSessionTask` completion and `ws.onopen`).
- **Protocol & security boundary (custom WebSocket clients & history snapshot)**:
  - Even if the browser runs sequentially (`fetchSession` $\rightarrow$ `connectWs` $\rightarrow$ `ClientJoin`), an external/non-browser client (such as the `AUTH-60` reproduction) can open `/ws/chat/{room_id}` and intentionally never send `ClientJoin`, or send a `ClientJoin` that fails (`NICKNAME_TAKEN` / `VALIDATION_ERROR`).
  - Furthermore, `ChatWs::on_join` loads the room's SQLite `ServerHistory` snapshot and sends `ServerJoined` + `ServerHistory`. Subscribing the actor to live `ServerMessage` broadcasts only *after* `on_join` succeeds prevents pushing live broadcasts to a socket that failed `NICKNAME_TAKEN` or hasn't received its history snapshot yet.
- **Future multi-room multiplexing (`1` WebSocket $\leftrightarrow$ `N` rooms)**:
  - As the protocol evolves so a single authenticated WebSocket connection can subscribe to or switch across multiple rooms in parallel without opening a new TCP/WebSocket connection per room, transport connection limits (`1 open socket`) and room pub/sub subscriptions (`N joined rooms`) must be tracked independently.

## Scope

- Refactor `RoomRegistry<A>` (`server/src/chat/service.rs`):
  - Track open connections (`open_connections: Vec<Addr<A>>`) separately from joined room broadcast recipients (`rooms: HashMap<String, Vec<Addr<A>>>`).
  - `try_register_connection(&self, addr: Addr<A>, max_connections: usize) -> bool` counts total open connections against `MAX_OPEN_CONNECTIONS` in `ChatWs::started` without adding `addr` to any room broadcast list.
  - `register_room_member(&self, room_id: &str, addr: Addr<A>)` adds `addr` (deduplicated) to the room's broadcast recipient list only after `on_join` succeeds.
  - `remove_connection(&self, room_id: &str, addr: &Addr<A>)` / `cleanup_room(&self, room_id: &str)` removes disconnected or revoked actors from both open connection tracking and the room's member list.
- Update `ChatWs::on_join` (`server/src/chat/messaging_actor.rs`):
  - Re-verify `self.session_token` via `get_valid_session_wallet` and `get_wallet_profile` (`has_active_access`) at join time.
  - Only call `CHAT_ROOMS.register_room_member(&room_id, addr.clone())` after nickname validation/persistence and room history loading succeed.
- Apply the recipient list rule uniformly to all `ChatWs::broadcast_to_room` callers:
  - Chat messages (`ServerMessage`)
  - Message deletions (`ServerDeleted`)
  - Attachment notifications (`ServerUploadDone`)
  - Voice state updates (`VoiceState`)

## Implementation Areas

- `server/src/chat/service.rs`
- `server/src/pages/chat/chat_actor.rs`
- `server/src/chat/messaging_actor.rs`
- `server/src/pages/chat/tests/`

## Tests and Acceptance

- [x] An authenticated, paid WebSocket connection that has not sent `Join` does not receive message, deletion, attachment, or voice broadcasts.
- [x] A connection whose `Join` fails (e.g., `NICKNAME_TAKEN` or invalid nickname) is not added to room broadcast recipients.
- [x] `MAX_OPEN_CONNECTIONS` still limits total open WebSocket connections (including unjoined ones) and releases slots on disconnect.
- [x] Two clients that complete `Join` in the same room exchange broadcasts normally while other rooms remain isolated.

## Result

**Status: DONE**

### Implemented modules
- `server/src/chat/service.rs` — refactored `RoomRegistry<A>` to track `open_connections` separately from `rooms` broadcast recipients (`try_register_connection`, `register_room_member`, `remove_room_member`, `remove_connection`, `connected_recipients`), plus unit test `room_registry_separates_open_connection_slots_from_room_members`.
- `server/src/pages/chat/chat_actor.rs` — registers only the transport connection slot in `ChatWs::started`, exposes `register_room_member` and `remove_connection`, and releases both connection slot and room membership in `ChatWs::stopped`.
- `server/src/chat/messaging_actor.rs` — registers the actor in `CHAT_ROOMS` broadcast recipients via `ChatWs::register_room_member` only after `on_join` verifies session token, active paid access, nickname ownership, and room history.
- `server/src/pages/chat/tests/messaging.rs` — added `unjoined_and_failed_join_connections_do_not_receive_room_broadcasts`.
