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
Новые log events (key=value формат):
- `event=attachment_upload_start attachment_id=? message_id=? filename=? size=? sender_id=?`
- `event=attachment_upload_done attachment_id=? sender_id=? room_id=?`
- `event=attachment_upload_cancelled upload_id=? sender_id=? reason=disconnect`
- `event=attachment_download_start attachment_id=? sender_id=?`
- `event=attachment_download_done attachment_id=? sender_id=?`
- `event=attachment_error code=? sender_id=? upload_id=? request_id=?`

### Protobuf decode errors
- Бинарный фрейм который не декодируется как `UploadChunk` → `error BAD_PAYLOAD`, соединение не падает.

### Filename safety
- `filename` хранится as-is, никакой нормализации пути (нет `../`, нет исполнения).
- При download: `Content-Disposition` не используется (скачивание через blob URL на клиенте) — filename применяется только в браузерном download через JS.

## Tests
- Size cap on upload_start: `size = 5MB + 1` → `UPLOAD_TOO_LARGE`, upload не создаётся.
- Size cap on chunk: суммарные данные чанков превышают `declared_size` → `UPLOAD_TOO_LARGE`.
- Storage limit: после вставки вложений превышающих 1 GB старые удаляются.
- Session isolation: `UploadChunk` с `upload_id` из другой сессии → `UPLOAD_NOT_FOUND`.
- Session limit: 4-й `upload_start` при 3 активных → `UPLOAD_LIMIT_EXCEEDED`.
- TTL expiry: `UploadChunk` или `upload_end` после 5 мин неактивности → `UPLOAD_EXPIRED`.
- TTL cleanup: просроченные uploads не накапливаются в памяти сессии.
- Disconnect cleanup: pending upload не появляется в БД после дисконнекта.
- Bad proto frame: невалидный бинарный фрейм → `BAD_PAYLOAD`, соединение выживает.
- Logging: события upload/download фиксируются в логах.

## Acceptance
- Файл >5 MB не может быть загружен ни через `upload_start`, ни через накопление чанков.
- Суммарное хранилище вложений не превышает 1 GB.
- Незавершённые uploads не оставляют мусора в БД.
- Невалидные бинарные фреймы не ломают WS соединение.
