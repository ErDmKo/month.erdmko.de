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
