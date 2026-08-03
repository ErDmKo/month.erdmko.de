---
title: "Chat MVP Data Layer"
ticket: "CHAT-20"
status: "completed"
draft: false
weight: 30
---

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

## Result

**Status: DONE**

### Schema & migration
`server/src/chat/db.rs` — `init_chat_schema()` (line 29):
- `rooms` table: `id`, `slug` (UNIQUE), `created_at`
- `messages` table: `id`, `room_id` (FK → rooms, CASCADE DELETE), `sender_id`, `sender_name`, `body` (CHECK length ≤ 200), `created_at`
- Index: `idx_messages_room_created_at ON messages(room_id, created_at)` (line 55)

### Data access functions
All in `server/src/chat/db.rs`:
- `create_room_if_not_exists()` line 137 — idempotent `INSERT OR IGNORE`
- `insert_message()` line 163 — validates body, inserts, enforces storage limit, returns full `ChatMessage`
- `get_recent_messages()` line 271 — queries DESC by `id`, reverses to chronological order, respects `HISTORY_LIMIT`
- `delete_message_by_id()` line 238 — scoped to room slug, returns `bool` indicating if a row was affected

### Body validation
`validate_chat_message_body()` (line 66) — rejects empty or >200 char bodies (counts Unicode chars, not bytes).

### Storage limits
- `enforce_messages_storage_limit()` line 77 — trims oldest messages when total body bytes exceed `MAX_MESSAGES_STORAGE_BYTES` (100 MB)
- `enforce_rooms_storage_limit()` line 105 — removes rooms with fewest messages first when slug storage exceeds `MAX_ROOMS_STORAGE_BYTES` (1 MB)

### Tests
All in `server/src/chat/db.rs` `#[cfg(test)]` block (line 321), each test uses an isolated in-memory SQLite file via temp dir:
- `create_room_is_idempotent` (line 349)
- `insert_and_fetch_recent_messages` (line 398)
- `rejects_invalid_message_body` (line 413)
- `deletes_oldest_messages_when_storage_limit_exceeded` (line 426)
- `delete_message_by_id_removes_target_message` (line 455)
- `delete_message_by_id_does_not_delete_message_from_other_room` (line 474)
- `deletes_rooms_with_fewer_messages_first_when_storage_limit_exceeded` (line 370)
- `deleting_room_cascades_messages` (line 495)
