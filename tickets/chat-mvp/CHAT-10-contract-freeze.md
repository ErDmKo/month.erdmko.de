# CHAT-10 API Contract Freeze

## Depends on
- `CHAT-00`

## Goal
Зафиксировать единый контракт HTTP + WS для frontend/backend.

## Scope
- Финализировать события: `join`, `message`, `joined`, `history`, `error`.
- Зафиксировать envelope: `type`, `requestId`, `ts`.
- Зафиксировать ошибки: `VALIDATION_ERROR`, `BAD_PAYLOAD`, `UNSUPPORTED_EVENT_TYPE`, `RATE_LIMITED`, `INTERNAL_ERROR`.
- Зафиксировать правила валидации: nickname `1..32`, body `1..200`.

## Deliverables
- Обновленный контракт в отдельном файле `/contracts/chat/CHAT_CONTRACT.md`.
- Короткие примеры payload для happy-path и ошибок.

## Tests
- Schema test: JSON-примеры из контракта валидируются (ручная/авто проверка полей).
- Compatibility test: backend принимает `join/message` строго по зафиксированным полям.
- Negative test: неизвестный `type` -> `error` с `UNSUPPORTED_EVENT_TYPE`.

## Acceptance
- Backend и frontend используют одинаковые имена событий и полей.
- Нет конфликтов по room-id логике (room только из URL).
- Источник правды по API/WS-контракту: `/contracts/chat/CHAT_CONTRACT.md`.

## Result

**Status: DONE**

### Contract file
`contracts/chat/CHAT_CONTRACT.md` — full HTTP + WS contract, payload examples, error codes, and limits.

### Events implemented
Client → Server (defined as `ClientEvent` enum in `server/src/chat/service.rs` line 78):
- `join` — nickname `1..32` chars after trim
- `message` — body `1..200` chars after trim
- `delete` — positive integer `messageId`

Server → Client (payload builders in `server/src/chat/service.rs`):
- `joined` — `joined_payload()` line 191, includes `self.senderId` / `self.senderName`
- `history` — `history_payload()` line 204
- `message` — `message_payload()` line 226
- `deleted` — `deleted_payload()` line 242
- `error` — `error_payload()` line 176

### Envelope
All server events include `type`, optional `requestId`, and `ts` (ISO8601 via `now_iso()` line 148).

### Error codes
Defined in `server/src/chat/error.rs`:
- `VALIDATION_ERROR` (line 26), `BAD_PAYLOAD` (line 32), `INTERNAL_ERROR` (line 42)
- `RATE_LIMITED`, `CONNECTION_LIMIT_EXCEEDED`, `UNSUPPORTED_EVENT_TYPE` emitted inline in `server/src/pages/chat.rs`

### Frontend protocol
`assets/js/chat/protocol.ts` mirrors all event types, constants, and validation rules:
- `MAX_MESSAGE_LEN = 200`, `MAX_NICKNAME_LEN = 32` (lines 4–5)
- `serializeCommand()` (line 23) and `validateOutgoingCommand()` (line 37) enforce the same rules client-side
