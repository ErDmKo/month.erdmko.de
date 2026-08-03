---
title: "Chat MVP Stability and Security"
ticket: "CHAT-60"
status: "completed"
draft: false
weight: 70
---

# CHAT-60 Stability & Security

## Depends on
- `CHAT-30`
- `CHAT-40`

## Goal
Закрыть базовые риски стабильности и безопасности MVP.

## Scope
- Лимит размера входящего WS payload.
- Простой rate limit на соединение.
- Structured logging: join, message, error, disconnect.
- Проверка безопасного вывода сообщений в UI.

## Deliverables
- Конфиг и обработчики лимитов.
- Логи ключевых событий.

## Tests
- Payload limit test: сообщение >4KB отклоняется с `BAD_PAYLOAD`.
- Rate limit test: превышение лимита сообщений -> `RATE_LIMITED`.
- Resilience test: после невалидного payload соединение не падает.
- Security test: сообщение с HTML/JS не исполняется в UI.
- Logging test: в логах фиксируются join/message/error/disconnect.

## Acceptance
- Невалидные payload не ломают соединение.
- Flood ограничивается, сервер продолжает работать стабильно.

## Result

**Status: DONE**

### Payload size limit
`server/src/chat/service.rs` — `is_valid_text_payload_size()` (line 152) checks `payload_len <= WS_MAX_PAYLOAD_BYTES` (4096 bytes).
Enforced in `server/src/pages/chat.rs` `StreamHandler` (line 118): oversized frames receive `BAD_PAYLOAD` error, connection stays open.

WS frame size also capped at `WS_FRAME_MAX_BYTES` (64 KB) via `WsResponseBuilder::frame_size()` (line 392).

### Rate limiting
`server/src/chat/service.rs` — `ChatSessionState::is_rate_limited()` (line 131):
- Sliding window: `RATE_LIMIT_MAX_MESSAGES = 5` messages per `RATE_LIMIT_WINDOW = 10s`
- Uses `VecDeque<Instant>` — pops expired timestamps on each call
- Returning `true` causes `RATE_LIMITED` error sent only to sender (line 218–228 in `chat.rs`)

### Connection limit
`server/src/chat/service.rs` — `MAX_OPEN_CONNECTIONS = 100` (line 21).
`RoomRegistry::try_register_connection()` (line 36) sums all connections across all rooms before accepting a new one. Rejected connections receive `CONNECTION_LIMIT_EXCEEDED` and are closed with `ws::CloseCode::Policy` (`server/src/pages/chat.rs` line 79–91).

### Structured logging
`server/src/pages/chat.rs` uses `log::info!` / `log::warn!` with consistent key=value fields:
- `event=chat_connect` (line 73)
- `event=chat_join` (line 194)
- `event=chat_message` (line 245)
- `event=chat_delete` (line 283)
- `event=chat_error` with `code=`, `request_id=` (lines 37–43, 80)
- `event=chat_disconnect` (line 98)

### Safe text rendering
`assets/js/chat/template.ts` — all message content set via `genText(body)` (line 117) which maps to `textContent` assignment in the VDOM helper. No `innerHTML` used anywhere in the chat UI.

### Tests covering stability & security
`server/src/pages/chat.rs` integration tests:
- `oversized_payload_returns_bad_payload_and_connection_survives` (line 643)
- `rate_limit_returns_rate_limited_error` (line 703)
- `malformed_payload_does_not_break_connection` (line 770)
