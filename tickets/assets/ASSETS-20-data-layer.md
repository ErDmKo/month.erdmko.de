# ASSETS-20 Data Layer

## Depends on
- `ASSETS-10`

## Goal
Реализовать хранение вложений в SQLite с привязкой к сообщениям чата.

## Scope

### Schema
Таблица `attachments` в `server/src/attachments/db.rs`:
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

### Constants (`server/src/attachments/mod.rs`)
- `MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024` (5 MB)
- `MAX_ATTACHMENTS_STORAGE_BYTES = 1024 * 1024 * 1024` (1 GB)
- `ATTACHMENT_CHUNK_SIZE = 64 * 1024` (64 KB)
- `MAX_ATTACHMENTS_PER_MESSAGE = 10` (объявлена, не enforced)
- `MAX_PENDING_UPLOADS_PER_SESSION = 3`
- `PENDING_UPLOAD_TTL = Duration::from_secs(300)`

### Data access functions
- `insert_attachment(conn, message_id, filename, size, mime_type, data) -> rusqlite::Result<Attachment>` — вставляет blob, возвращает `Attachment { meta, data }` через re-query по `last_insert_rowid()`
- `get_attachments_for_message(conn, message_id) -> rusqlite::Result<Vec<AttachmentMeta>>` — метаданные без `data`, ORDER BY id ASC
- `get_attachment_data(conn, attachment_id, room_slug) -> rusqlite::Result<Option<(AttachmentMeta, Vec<u8>)>>` — JOIN через messages → rooms по slug; `QueryReturnedNoRows` → `Ok(None)`
- `get_attachments_for_messages(conn, message_ids) -> rusqlite::Result<HashMap<i64, Vec<AttachmentMeta>>>` — батч IN-запрос, группирует по message_id; пустой слайс → пустая HashMap без запроса
- `enforce_attachments_storage_limit(conn, max_bytes) -> rusqlite::Result<()>` — loop: SUM(size) > max_bytes → DELETE oldest (ORDER BY created_at ASC, id ASC LIMIT 1)

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

// Внутренний тип — используется только при загрузке blob для download
pub struct Attachment {
    pub meta: AttachmentMeta,
    pub data: Vec<u8>,
}
```

### Schema initialization
Отдельная функция `init_attachments_schema(conn)` в `db.rs`. Вызывается из `main.rs` после `init_chat_schema`.

### Message model extension
`ChatMessage` в `server/src/chat/db.rs` расширен полем `attachments: Vec<AttachmentMeta>`.
`get_recent_messages()` после загрузки сообщений делает батч-запрос `get_attachments_for_messages` и заполняет `attachments` для каждого `ChatMessage`.

## Deliverables
- [x] `server/src/attachments/db.rs` — таблица, индекс, все функции доступа, inline tests.
- [x] `server/src/attachments/mod.rs` — все константы.
- [x] `server/src/attachments/error.rs` — `ChatErrorKind` enum (Validation, BadPayload, Internal), `ChatError` struct (пока не используется в db.rs — ошибки propagate как `rusqlite::Error`).
- [x] Обновлённый `ChatMessage` с полем `attachments: Vec<AttachmentMeta>`.
- [x] `get_recent_messages()` с батч-запросом вложений.
- [x] `init_attachments_schema()` вызывается при старте.

## Tests (все реализованы, `#[cfg(test)]` в `db.rs`)
- [x] Migration: таблица и индекс `idx_attachments_message_id` создаются.
- [x] Insert: `insert_attachment` сохраняет все поля корректно, `id > 0`.
- [x] Fetch: `get_attachments_for_message` возвращает 2 записи, `data` не экспонируется.
- [x] Data: `get_attachment_data` возвращает blob для правильной комнаты.
- [x] Cascade: удаление `messages` строки → `attachments` удаляются (PRAGMA foreign_keys = ON).
- [x] Room scope: `get_attachment_data` возвращает `None` для неправильной комнаты.
- [x] Storage limit: 3×10 bytes, limit=15 → два старых удаляются, новый остаётся.
- [x] Batch: `get_attachments_for_messages` группирует по `message_id`.

## Notes
- `MAX_ATTACHMENTS_PER_MESSAGE = 10` объявлена в `mod.rs` но нигде не enforced — `insert_attachment` не проверяет количество вложений у сообщения.
- `error.rs` содержит `ChatError` / `ChatErrorKind` но в db-функциях не используется — ошибки propagate как `rusqlite::Error` напрямую.

## Acceptance
- Вложения хранятся как opaque blobs — никакой обработки содержимого.
- Удаление сообщения или комнаты автоматически удаляет вложения через CASCADE.
- История сообщений включает метаданные вложений без дополнительных запросов со стороны клиента.
