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

## Result

**Status: DONE**

### Constants
Defined in `server/src/chat/service.rs`:
- `MAX_MESSAGE_LEN = 200` (line 14)
- `HISTORY_LIMIT = 50` (line 16)
- `WS_MAX_PAYLOAD_BYTES = 4096` (line 17)
- Additional limits: `MAX_OPEN_CONNECTIONS = 100`, `WS_FRAME_MAX_BYTES = 64KB`, `RATE_LIMIT_MAX_MESSAGES = 5`

### Chat module structure
`server/src/chat/mod.rs` — module root exposing `db`, `error`, `service` submodules.

### Routes
Both routes registered in `server/src/pages/chat.rs`:
- `GET /chat/{room_id}` → `chat_room_page_handler` (line 340) — renders `server/templates/chat.html`
- `GET /ws/chat/{room_id}` → `chat_ws_page_handler` (line 352) — performs WS upgrade with `actix-web-actors`
