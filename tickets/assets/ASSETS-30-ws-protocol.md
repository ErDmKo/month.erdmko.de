# ASSETS-30 WebSocket Protocol

## Depends on
- `ASSETS-20`

## Goal
Реализовать полный цикл загрузки и выгрузки файлов через WebSocket с использованием protobuf для бинарных чанков.

## Scope

### Backend — Rust

#### Pending upload state
В `server/src/attachments/service.rs` — структура `PendingUpload`:
```rust
pub struct PendingUpload {
    pub upload_id:     String,         // UUID
    pub message_id:    i64,
    pub filename:      String,
    pub size:          usize,
    pub mime_type:     String,
    pub chunks:        Vec<Vec<u8>>,
    pub next_index:    u32,
    pub last_activity: Instant,        // updated on every UploadChunk
}
```
Новые константы в `service.rs`:
- `MAX_PENDING_UPLOADS_PER_SESSION = 3`
- `PENDING_UPLOAD_TTL = Duration::from_secs(300)` (5 мин)
Pending uploads хранятся в `HashMap<String, PendingUpload>` внутри `ChatWs` сессии — при дисконнекте автоматически очищаются.

Лимиты pending uploads:
- Максимум **3 одновременных** pending upload на сессию. `upload_start` при достижении лимита → `error UPLOAD_LIMIT_EXCEEDED`.
- TTL **5 минут** без активности (без получения чанков). Каждый `UploadChunk` обновляет `last_activity: Instant`. При следующем `upload_start` или `UploadChunk` сервер проверяет и удаляет просроченные uploads перед обработкой запроса. Просроченный `upload_id` → `error UPLOAD_EXPIRED`.

#### Обработка событий в `StreamHandler`

**Текстовые фреймы (JSON):**
- `upload_start` → валидация полей → создать `PendingUpload` → ответить `upload_ready { uploadId }`
- `upload_end` → проверить что все чанки получены → вызвать `insert_attachment()` → применить storage limit → broadcast `upload_done` по комнате
- `download_request` → проверить `attachment_id` принадлежит комнате → отправить `download_start` → стримить `DownloadChunk` бинарными фреймами → отправить `download_end`

**Бинарные фреймы (protobuf):**
- Декодировать как `UploadChunk` через `prost`
- Проверить `upload_id` существует в сессии
- Проверить `index == pending.next_index`
- Проверить `pending.chunks total size + chunk.data.len() <= declared size`
- Добавить `chunk.data` в `pending.chunks`, инкрементировать `next_index`

#### Download streaming
Сервер читает blob из БД, делит на чанки по `ATTACHMENT_CHUNK_SIZE` (64 KB), сериализует каждый как `DownloadChunk` через `prost`, отправляет бинарными WS-фреймами между `download_start` и `download_end`.

### Frontend — TypeScript

#### Protobuf serializer `assets/js/chat/attachments-proto.ts`
Ручной сериализатор/десериализатор для `UploadChunk` и `DownloadChunk` строго по полям из `.proto`:
```typescript
// Encode UploadChunk → Uint8Array
export const encodeUploadChunk = (uploadId: string, index: number, data: Uint8Array): Uint8Array

// Decode DownloadChunk ← Uint8Array
export const decodeDownloadChunk = (buf: Uint8Array): { attachmentId: string; index: number; data: Uint8Array }
```
- Использует protobuf wire format: field tags, varint, length-delimited.
- Покрыт unit-тестами — encode → decode roundtrip для обоих типов.
- Комментарий в файле: `// TODO: replace with @bufbuild/protobuf when all binary messages migrate to proto`

#### Upload flow `assets/js/chat/upload.ts`
```
selectFile() → validate size ≤ 5MB → send upload_start (JSON)
→ onmessage upload_ready → slice file into 64KB chunks
→ send each chunk as UploadChunk binary frame
→ send upload_end (JSON)
→ onmessage upload_done → update message UI with attachment metadata
```

#### Download flow `assets/js/chat/download.ts`
```
click download button → send download_request (JSON)
→ onmessage download_start → prepare buffer, totalChunks
→ onmessage DownloadChunk (binary) → decode → append to buffer
→ onmessage download_end → assemble Blob → trigger browser download
```

## Deliverables
- `server/src/attachments/service.rs` — pending upload state, event handlers, download streaming.
- `server/src/pages/chat.rs` — расширен для обработки новых JSON событий и бинарных фреймов вложений.
- `assets/js/chat/attachments-proto.ts` — ручной protobuf сериализатор.
- `assets/js/chat/upload.ts` — логика загрузки.
- `assets/js/chat/download.ts` — логика выгрузки.

## Tests

### Backend (integration, реальный WS сервер)
- Upload happy path: `upload_start` → N `UploadChunk` → `upload_end` → получен `upload_done` с корректными метаданными.
- Download happy path: после upload клиент запрашивает `download_request` → получает `download_start` + N бинарных чанков + `download_end`, сборка совпадает с оригиналом.
- Out-of-order chunk: отправить chunk с `index=1` первым → `error UPLOAD_CHUNK_OUT_OF_ORDER`.
- Early upload_end: `upload_end` без всех чанков → `error UPLOAD_INCOMPLETE`.
- Unknown upload_id: `UploadChunk` с несуществующим `upload_id` → `error UPLOAD_NOT_FOUND`.
- Session limit: `upload_start` при 3 активных uploads → `error UPLOAD_LIMIT_EXCEEDED`.
- TTL expiry: `UploadChunk` или `upload_end` для upload старше 5 мин → `error UPLOAD_EXPIRED`.
- Room scope: `download_request` для `attachment_id` из другой комнаты → `error ATTACHMENT_NOT_FOUND`.
- Disconnect cancels upload: незавершённый upload не сохраняется в БД.
- Upload_done broadcast: второй клиент в комнате получает `upload_done`.

### Frontend (unit)
- `encodeUploadChunk` → `decodeUploadChunk` roundtrip корректен.
- `encodeDownloadChunk` → `decodeDownloadChunk` roundtrip корректен (для тестирования десериализатора).
- Файл >5 MB не начинает загрузку.

## Acceptance
- Файл загружается и выгружается через WS без потери байт.
- Бинарные чанки сериализованы строго по `.proto` контракту.
- Pending upload не сохраняется при дисконнекте.
- Второй клиент в комнате получает `upload_done` и видит вложение.
