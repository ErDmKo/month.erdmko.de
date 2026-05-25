# ASSETS-30 WebSocket Protocol

## Depends on
- `ASSETS-20`

## Goal
Реализовать полный цикл загрузки и выгрузки файлов через WebSocket с использованием protobuf для всех фреймов.

## Scope

### Backend — Rust

#### Pending upload state
`server/src/attachments/service.rs` — структура `PendingUpload`:
```rust
pub struct PendingUpload {
    pub upload_id:     u32,            // auto-increment per session (not UUID)
    pub message_id:    i64,
    pub filename:      String,
    pub size:          usize,          // declared size in bytes
    pub mime_type:     String,
    pub chunks:        Vec<Vec<u8>>,
    pub next_index:    u32,
    pub last_activity: Instant,        // updated on every UploadChunk
}
```
Константы в `server/src/attachments/mod.rs`:
- `MAX_PENDING_UPLOADS_PER_SESSION = 3`
- `PENDING_UPLOAD_TTL = Duration::from_secs(300)` (5 мин)
- `MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024` (5 MB)
- `ATTACHMENT_CHUNK_SIZE = 64 * 1024` (64 KB)

Pending uploads хранятся в `UploadSessionState` (`HashMap<u32, PendingUpload>` + `next_id: u32`) внутри `ChatWs` актора — при дисконнекте автоматически очищаются.

#### Все фреймы бинарные (protobuf), JSON не используется

Протокол полностью protobuf. Нет JSON-фреймов. Контракт определён в `contracts/chat/chat.proto` (`ClientFrame` / `ServerFrame` oneof-обёртки). Сервер использует `prost` для encode/decode.

**ClientFrame варианты:** Join, Message, Delete, UploadStart, UploadEnd, DownloadRequest, UploadChunk

**ServerFrame варианты:** Joined, History, Message, Deleted, Error, UploadReady, UploadDone, DownloadStart, DownloadEnd, DownloadChunk

Обработка в `dispatch.rs` (`on_binary`):
- Пустой или слишком большой фрейм → `BAD_PAYLOAD`, соединение не закрывается
- `parse_client_event` (prost decode `ClientFrame`) → `BAD_PAYLOAD` при ошибке
- `UploadChunk` обрабатывается inline через `uploads.add_chunk()`; все остальные варианты — делегируются методам актора

`UploadSessionState` методы:
- `start_upload()` — purge_expired → enforce MAX_PENDING_UPLOADS_PER_SESSION → insert
- `add_chunk()` — purge_expired → find → check not expired → check order → check size → append
- `finish_upload()` — purge_expired → find → check not expired → check accumulated == declared size → remove and return
- `purge_expired()` — `retain(|_, v| !v.is_expired())`

#### Download streaming
`on_download_request` в `attachments.rs`: async spawn → `load_attachment_for_download` (room-scoped) → `download_start_payload` → N×`encode_download_chunk` (PushBinary) → `download_end_payload`. Весь blob читается из БД в память перед стримингом.

### Frontend — TypeScript

#### Архитектура (как реализовано)
Монолитных `upload.ts` / `download.ts` нет. Логика разбита на субмодули:

- `assets/js/chat/generated/chat.ts` — полный protobuf кодек (все типы, encode/decode, field-index константы). Генерируется через `bazel run //assets/js/tools:gen-proto` из `chat.proto`. Типы — readonly tuple-массивы для zero-overhead доступа.
- `assets/js/utils/proto-utils.ts` — низкоуровневая wire-format библиотека (varint, Reader, field encoders, `decodeOneofFrame`)
- `assets/js/chat/protocol/incoming.ts` — `parseBinaryFrame`, `BaseChatSocket`, `ChatSocket`
- `assets/js/chat/protocol/outgoing.ts` — `serializeCommand`, `validateOutgoingCommand`
- `assets/js/chat/attachments/handler.ts` — `startUpload`, `startDownload`, `renderAttachment`, `triggerBrowserDownload`
- `assets/js/chat/attachments/init.ts` — `initAttachments` (wiring)

#### Upload flow (`attachments/handler.ts`, `attachments/init.ts`)
```
CHAT_UI_FILE_SELECTED → validate size ≤ 5MB → show upload preview
→ on message submit → waitForMessageId(requestId) → startUpload()
  → CLIENT_FRAME_UPLOAD_START
  → SERVER_FRAME_UPLOAD_READY → readFileAsArrayBuffer → sendChunks (CLIENT_FRAME_UPLOAD_CHUNK)
  → CLIENT_FRAME_UPLOAD_END
  → SERVER_FRAME_UPLOAD_DONE → renderAttachmentFromUploadDone
```

`startUpload` возвращает `ObserverInstance<UploadEvent>` с событиями:
- `UPLOAD_READY` — сервер подтвердил start
- `UPLOAD_PROGRESS [sent, total]` — после каждого чанка
- `UPLOAD_DONE` — сервер прислал upload_done
- `UPLOAD_ERROR [code, message]`

#### Download flow (`attachments/handler.ts`)
```
onDownloadClick → startDownload()
  → CLIENT_FRAME_DOWNLOAD_REQUEST
  → SERVER_FRAME_DOWNLOAD_START → инициализация сессии [meta, chunks[], received=0, endSeen=false]
  → SERVER_FRAME_DOWNLOAD_CHUNK → chunks[index] = data; received++
  → SERVER_FRAME_DOWNLOAD_END → endSeen = true
  → tryAssembleBlob: ждёт endSeen && received >= totalChunks → Blob → triggerBrowserDownload
```

`startDownload` возвращает `ObserverInstance<DownloadEvent>`:
- `DOWNLOAD_START [meta]`
- `DOWNLOAD_PROGRESS [received, total]`
- `DOWNLOAD_DONE [blob, filename]`
- `DOWNLOAD_ERROR [code, message]`

Сборка blob происходит только когда получены ВСЕ чанки И `download_end` — гарантирует корректность при out-of-order доставке.

## Deliverables (как реализовано)
- `server/src/attachments/service.rs` — `PendingUpload`, `UploadSessionState`, `persist_upload`, `load_attachment_for_download`, `split_into_chunks` (реализовано).
- `server/src/pages/chat/actor/dispatch.rs` — `on_binary`, маршрутизация всех вариантов `ClientFrame` (реализовано).
- `server/src/pages/chat/actor/attachments.rs` — `on_upload_start`, `on_upload_end`, `on_download_request` (реализовано).
- `contracts/chat/chat.proto` + `contracts/chat/BUILD.bazel` — контракт (реализовано).
- `server/src/generated/chat.rs` — prost-сгенерированные типы (реализовано).
- `assets/js/chat/generated/chat.ts` — TS кодек (реализовано).
- `assets/js/utils/proto-utils.ts` — wire-format утилиты (реализовано).
- `assets/js/chat/attachments/handler.ts` — upload/download логика (реализовано).
- `assets/js/chat/attachments/init.ts` — wiring (реализовано).
- `assets/js/chat/protocol/` — incoming/outgoing протокол (реализовано).

## Отличия от первоначального дизайна
| Дизайн | Реализация |
|---|---|
| `upload_id: String` (UUID) | `upload_id: u32` (auto-increment per session) |
| JSON для управляющих фреймов + proto только для чанков | Всё protobuf (`ClientFrame`/`ServerFrame` oneof) |
| `attachments-proto.ts` — отдельный ручной сериализатор | `generated/chat.ts` — полный автогенерированный кодек из `.proto` |
| `upload.ts` + `download.ts` как отдельные модули | Объединены в `attachments/handler.ts` |
| `assets/js/chat/template/` как отдельная директория | Templates в `chat-ui/`, `messages/`, `attachments/` субмодулях |
| Комментарий `// TODO: replace with @bufbuild/protobuf` | Собственный кодек без внешних зависимостей, TODO не актуален |

## Tests

### Backend (unit, `server/src/attachments/service.rs`)
- [x] Upload happy path: start → chunks → finish → correct accumulated size
- [x] Out-of-order chunk → `UPLOAD_CHUNK_OUT_OF_ORDER`
- [x] Unknown upload_id → `UPLOAD_NOT_FOUND`
- [x] Session limit (MAX_PENDING_UPLOADS_PER_SESSION) → `UPLOAD_LIMIT_EXCEEDED`
- [x] Incomplete upload (finish before all chunks) → `UPLOAD_INCOMPLETE`
- [x] Chunk size overflow (accumulated > declared) → `UPLOAD_TOO_LARGE`
- [x] `encode_download_chunk` protobuf round-trip
- [x] `split_into_chunks` sizes

### Frontend (unit)
- [x] `UploadChunk` encode/decode round-trip (`attachments-proto.test.ts`)
- [x] `DownloadChunk` encode/decode round-trip
- [x] `UploadChunk` with `index=0` and empty data

### Missing tests
- [ ] TTL expiry: `UploadChunk`/`upload_end` после 5 мин → `UPLOAD_EXPIRED`
- [ ] TTL cleanup: просроченные uploads не накапливаются
- [ ] Disconnect cancels upload: pending upload не сохраняется в БД
- [ ] Upload_done broadcast: второй клиент в комнате получает `upload_done`
- [ ] Room scope: `download_request` для `attachment_id` из другой комнаты → `ATTACHMENT_NOT_FOUND`
- [ ] Full upload→download round-trip: байты совпадают с оригиналом

## Acceptance
- Файл загружается и выгружается через WS без потери байт.
- Все фреймы сериализованы через protobuf строго по `chat.proto` контракту.
- Pending upload не сохраняется при дисконнекте.
- Второй клиент в комнате получает `upload_done` и видит вложение.
