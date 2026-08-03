---
title: "Chat MVP WebSocket Room Hub"
ticket: "CHAT-30"
status: "completed"
draft: false
weight: 40
---

# CHAT-30 WebSocket Room Hub

## Depends on
- `CHAT-20`

## Goal
Сделать realtime-обмен сообщениями между 2+ клиентами в комнате.

## Scope
- In-memory room registry: `room_id -> connections`.
- Обработать `join`: join room + отправка `history`.
- Обработать `message`: validate + persist + broadcast.
- Cleanup на disconnect.

## Deliverables
- Рабочий WS handler для `/ws/chat/{room_id}`.
- Broadcast только после успешного сохранения сообщения.

## Tests
- Integration test: два WS-клиента в одной комнате получают broadcast.
- Isolation test: клиент из другой комнаты не получает сообщение.
- Join test: после `join` клиент получает `history`.
- Negative test: невалидный payload -> `error` только отправителю.
- Disconnect test: после disconnect соединение удаляется из room registry.

## Acceptance
- 2 клиента в одной комнате видят сообщения друг друга в realtime.
- Ошибки валидации отправляются только инициатору.

## Result

**Status: DONE**

### Room registry
`server/src/chat/service.rs` — `RoomRegistry<A>` struct (line 25):
- Wraps `Arc<RwLock<HashMap<String, Vec<Addr<A>>>>>` for thread-safe room → connections mapping
- `try_register_connection()` line 36 — enforces `MAX_OPEN_CONNECTIONS` (100), prunes dead connections before adding
- `cleanup_room()` line 51 — removes dead addresses, deletes empty rooms
- `connected_recipients()` line 64 — returns live addresses for broadcast

Global singleton: `static CHAT_ROOMS: LazyLock<RoomRegistry<ChatWs>>` in `server/src/pages/chat.rs` line 14.

### WebSocket actor
`server/src/pages/chat.rs` — `ChatWs` struct (line 20):
- `Actor::started()` line 70 — registers connection; sends `CONNECTION_LIMIT_EXCEEDED` and closes if limit hit
- `Actor::stopped()` line 94 — calls `cleanup_room()` on disconnect
- `StreamHandler` line 113 — handles all incoming WS frames

### Event handling
All in `server/src/pages/chat.rs` `StreamHandler` (line 113):
- `join`: validates nickname → `ChatSessionState::set_nickname()` → spawns async task to call `join_room_and_get_history()` → sends `joined` + `history` back to sender only (line 153)
- `message`: checks `sender_name` exists → checks rate limit → spawns async persist → on success calls `broadcast_to_room()` (line 206)
- `delete`: spawns async `delete_message()` → on success calls `broadcast_to_room()` with `deleted` payload (line 271)
- Errors sent only to sender via `Self::send_error()` (line 29) / `addr.do_send(PushEvent(...))`

### Broadcast
`broadcast_to_room()` line 59 — iterates `connected_recipients()`, calls `addr.do_send(PushEvent(...))` for each.

### Tests
Integration tests in `server/src/pages/chat.rs` `#[cfg(test)]` block (line 396), each spins up a real `HttpServer` on a random port:
- `join_sends_joined_and_history` (line 494)
- `message_broadcasts_only_inside_room` (line 557) — verifies isolation between rooms
- `oversized_payload_returns_bad_payload_and_connection_survives` (line 643)
- `rate_limit_returns_rate_limited_error` (line 703)
- `malformed_payload_does_not_break_connection` (line 770)
- `delete_broadcasts_deleted_event_to_room_clients` (line 824)
