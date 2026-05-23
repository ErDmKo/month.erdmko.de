# ASSETS-50 Stability & Security

## Depends on
- `ASSETS-40`

## Goal
Закрыть базовые риски стабильности и безопасности для файловых вложений.

## Scope

### Per-file size enforcement
- `upload_start` с `size > MAX_ATTACHMENT_SIZE_BYTES` (5 MB) → немедленный `error UPLOAD_TOO_LARGE`, upload не создаётся.
- Суммарный размер полученных chunk data не может превысить задекларированный `size` — каждый чанк проверяется: `accumulated + chunk.len() > declared_size` → `error UPLOAD_TOO_LARGE`.

### Storage limit enforcement
После успешного `insert_attachment()` вызывать `enforce_attachments_storage_limit()`:
- Удаляет самые старые вложения (по `created_at ASC, id ASC`) пока `SUM(size) > MAX_ATTACHMENTS_STORAGE_BYTES` (1 GB).
- Cascade DELETE в SQLite автоматически не удаляет сообщение — удаляется только blob.

### Upload session isolation
- Pending uploads живут только в памяти сессии `ChatWs`.
- При дисконнекте все pending uploads этой сессии отбрасываются без записи в БД.
- Нельзя отправить `UploadChunk` для `upload_id` созданного другой сессией.
- Максимум **3 pending uploads** на сессию одновременно (`MAX_PENDING_UPLOADS_PER_SESSION = 3`). При превышении → `error UPLOAD_LIMIT_EXCEEDED`.
- TTL **5 минут** без активности (`PENDING_UPLOAD_TTL = 300s`). Просроченные uploads очищаются при следующем `upload_start` или `UploadChunk`. Обращение к просроченному `upload_id` → `error UPLOAD_EXPIRED`.

### Concurrent download safety
- Несколько одновременных `download_request` от одного клиента разрешены (разные `attachment_id`).
- Один и тот же `attachment_id` запрошенный дважды одновременно — сервер обрабатывает оба независимо.

### Structured logging
Log events (key=value формат) — реализовано в `server/src/pages/chat/actor/`:

| event | level | поля |
|---|---|---|
| `attachment_upload_start` | info | `upload_id`, `message_id`, `filename`, `size`, `mime_type`, `sender_id` |
| `attachment_upload_done` | info | `attachment_id`, `sender_id`, `room_id` |
| `attachment_upload_cancelled` | info | `upload_id`, `sender_id`, `reason=disconnect` |
| `attachment_download_start` | info | `attachment_id`, `sender_id`, `total_chunks` |
| `attachment_download_done` | info | `attachment_id`, `sender_id` |
| `attachment_error` | warn | `code`, `sender_id`, `upload_id`/`attachment_id`/`request_id` (context-dependent) |

Примечание: `attachment_upload_start` логирует `upload_id` (не `attachment_id` — DB-id появляется позже в `attachment_upload_done`).

### Protobuf decode errors
- Бинарный фрейм который не декодируется → `error BAD_PAYLOAD`, соединение не падает.
- Реализовано в `dispatch.rs`: `parse_client_event` возвращает `ChatError::bad_payload`, `on_binary` отправляет ошибку клиенту и `return` без закрытия соединения.

### Filename safety
- `filename` хранится as-is, никакой нормализации пути (нет `../`, нет исполнения).
- При download: `Content-Disposition` не используется (скачивание через blob URL на клиенте) — filename применяется только в браузерном download через JS.

## Implementation notes

### Already implemented (inherited from earlier tickets)
- Per-file size check in `on_upload_start` (`attachments.rs`) — `size == 0 || size > MAX_ATTACHMENT_SIZE_BYTES` → `UPLOAD_TOO_LARGE`
- Chunk accumulation size check in `UploadSessionState::add_chunk` (`attachments/service.rs`) — `accumulated + chunk.len() > declared_size` → `UPLOAD_TOO_LARGE`
- `enforce_attachments_storage_limit()` called in `persist_upload()` after `insert_attachment()`
- Session isolation: `UploadSessionState` lives in `ChatWs` actor, dropped on disconnect without DB write
- `MAX_PENDING_UPLOADS_PER_SESSION = 3` enforced in `start_upload()`
- `PENDING_UPLOAD_TTL = 300s` enforced via `purge_expired()` called on every operation
- `UPLOAD_NOT_FOUND` / `UPLOAD_EXPIRED` / `UPLOAD_LIMIT_EXCEEDED` error codes wired end-to-end
- `BAD_PAYLOAD` already sent on empty frame, oversized frame, and protobuf decode failure
- Concurrent downloads: each `download_request` spawns an independent async task

### Implemented in this ticket (ASSETS-50)
- Full structured logging for all attachment lifecycle events (`attachments.rs`, `dispatch.rs`)
- `attachment_upload_cancelled` log on disconnect: `stopped()` in `mod.rs` iterates `uploads.pending_upload_ids()` and logs each
- `UploadSessionState::pending_upload_ids()` method added to `attachments/service.rs`
- `attachment_error` log added for UploadChunk errors in `dispatch.rs`
- Comment added in `dispatch.rs` explaining BAD_PAYLOAD keeps connection alive

## Tests
- [ ] Size cap on upload_start: `size = 5MB + 1` → `UPLOAD_TOO_LARGE`, upload не создаётся.
- [ ] Size cap on chunk: суммарные данные чанков превышают `declared_size` → `UPLOAD_TOO_LARGE`.
- [ ] Storage limit: после вставки вложений превышающих 1 GB старые удаляются.
- [ ] Session isolation: `UploadChunk` с `upload_id` из другой сессии → `UPLOAD_NOT_FOUND`.
- [ ] Session limit: 4-й `upload_start` при 3 активных → `UPLOAD_LIMIT_EXCEEDED`.
- [ ] TTL expiry: `UploadChunk` или `upload_end` после 5 мин неактивности → `UPLOAD_EXPIRED`.
- [ ] TTL cleanup: просроченные uploads не накапливаются в памяти сессии.
- [ ] Disconnect cleanup: pending upload не появляется в БД после дисконнекта.
- [ ] Bad proto frame: невалидный бинарный фрейм → `BAD_PAYLOAD`, соединение выживает.
- [ ] Logging: события upload/download фиксируются в логах.

## Acceptance
- Файл >5 MB не может быть загружен ни через `upload_start`, ни через накопление чанков.
- Суммарное хранилище вложений не превышает 1 GB.
- Незавершённые uploads не оставляют мусора в БД.
- Невалидные бинарные фреймы не ломают WS соединение.

## TODO
- [x] Structured logging: attachment_upload_start, upload_done, upload_cancelled, download_start, download_done, attachment_error
- [x] Log pending upload cancellations on disconnect
- [x] Verify/document BAD_PAYLOAD flow (connection survival)
- [ ] Написать тесты (список выше)

