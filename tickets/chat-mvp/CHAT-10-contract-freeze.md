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
- Обновленный контракт в `/CHAT_MVP_PLAN.md`.
- Короткие примеры payload для happy-path и ошибок.

## Tests
- Schema test: JSON-примеры из контракта валидируются (ручная/авто проверка полей).
- Compatibility test: backend принимает `join/message` строго по зафиксированным полям.
- Negative test: неизвестный `type` -> `error` с `UNSUPPORTED_EVENT_TYPE`.

## Acceptance
- Backend и frontend используют одинаковые имена событий и полей.
- Нет конфликтов по room-id логике (room только из URL).
