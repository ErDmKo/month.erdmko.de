# CHAT-20 Data Layer

## Depends on
- `CHAT-10`

## Goal
Реализовать хранение комнат и сообщений в SQLite.

## Scope
- Таблицы: `rooms`, `messages`.
- Индекс: `messages(room_id, created_at)`.
- Функции:
- `create_room_if_not_exists(room_id)`
- `insert_message(room_id, sender_id, sender_name, body)`
- `get_recent_messages(room_id, limit)`
- Серверная валидация body `1..200`.

## Deliverables
- SQL migration/инициализация.
- Методы доступа к данным в `server/src/db.rs` (или выделенный модуль).

## Tests
- DB migration test: таблицы/индексы создаются успешно.
- Unit test: `create_room_if_not_exists` идемпотентен.
- Unit test: `insert_message` сохраняет корректные поля.
- Unit test: `get_recent_messages` возвращает лимит и правильный порядок.
- Validation test: пустое и >200 символов сообщение отклоняется.

## Acceptance
- Сообщения сохраняются и читаются по комнате.
- История возвращается в правильном порядке.
