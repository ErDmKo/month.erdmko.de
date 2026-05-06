# ASSETS-20 Data Layer

## Depends on
- `ASSETS-10`

## Goal
Реализовать хранение вложений в SQLite с привязкой к сообщениям чата.

## Scope

### Schema
Новая таблица `attachments` в `server/src/attachments/db.rs`:
```sql
CREATE TABLE IF NOT EXISTS attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL,
    filename    TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    mime_type   TEXT    NOT NULL,
    data        BLOB    NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_message_id
    ON attachments(message_id);
```

- `FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE` — удаление сообщения автоматически удаляет все вложения.
- `data BLOB` — сырые байты файла, без обработки.

### Data access functions
- `insert_attachment(message_id, filename, size, mime_type, data) -> Attachment`
- `get_attachments_for_message(message_id) -> Vec<AttachmentMeta>` — возвращает метаданные без `data`
- `get_attachment_data(attachment_id, room_slug) -> Option<(AttachmentMeta, Vec<u8>)>` — проверяет принадлежность к комнате
- `get_attachments_for_messages(message_ids) -> HashMap<i64, Vec<AttachmentMeta>>` — батч-запрос для history

### Models
```rust
pub struct AttachmentMeta {
    pub id:         i64,
    pub message_id: i64,
    pub filename:   String,
    pub size:       i64,
    pub mime_type:  String,
    pub created_at: String,
}
```

### Storage limit
`enforce_attachments_storage_limit(conn, max_bytes)` — удаляет самые старые вложения (по `created_at ASC, id ASC`) пока суммарный `size` превышает `MAX_ATTACHMENTS_STORAGE_BYTES` (1 GB).

### Message model extension
`get_recent_messages()` в `server/src/chat/db.rs` расширяется: после получения списка сообщений делает батч-запрос вложений и добавляет `attachments: Vec<AttachmentMeta>` к каждому `ChatMessage`.

## Deliverables
- `server/src/attachments/db.rs` с таблицей, индексом и функциями доступа.
- Обновлённый `ChatMessage` с полем `attachments`.
- Обновлённый `init_chat_schema()` или отдельный `init_attachments_schema()`.

## Tests
- Migration test: таблица и индекс создаются успешно.
- Insert test: `insert_attachment` сохраняет все поля корректно.
- Fetch test: `get_attachments_for_message` возвращает метаданные без `data`.
- Data test: `get_attachment_data` возвращает blob и проверяет room scope.
- Cascade test: удаление сообщения удаляет его вложения.
- Room scope test: `get_attachment_data` не возвращает вложение из другой комнаты.
- Storage limit test: при превышении 1 GB удаляются самые старые вложения.
- Batch test: `get_attachments_for_messages` корректно группирует по `message_id`.

## Acceptance
- Вложения хранятся как opaque blobs — никакой обработки содержимого.
- Удаление сообщения или комнаты автоматически удаляет вложения через CASCADE.
- История сообщений включает метаданные вложений без дополнительных запросов со стороны клиента.
