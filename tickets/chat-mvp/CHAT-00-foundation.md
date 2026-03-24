# CHAT-00 Foundation

## Depends on
- none

## Goal
Подготовить каркас под MVP-чата без бизнес-логики.

## Scope
- Подключить пустые модули чата в backend.
- Добавить константы `MAX_MESSAGE_LEN=200`, `HISTORY_LIMIT=50`, `WS_MAX_PAYLOAD_BYTES=4096`.
- Подключить роуты-заглушки для `/chat/{room_id}` и `/ws/chat/{room_id}`.

## Deliverables
- Сборка проекта проходит.
- Приложение стартует с новыми роутами без panic.

## Tests
- Build test: проект собирается (`cargo check`/bazel build).
- Route smoke: `GET /chat/general` возвращает `200`.
- Route smoke: `GET /ws/chat/general` делает `101` upgrade при WS handshake.

## Acceptance
- `cargo`/bazel сборка успешна.
- `GET /chat/general` отвечает (можно заглушкой).
