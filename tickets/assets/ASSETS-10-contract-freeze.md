---
title: "Assets Contract Freeze"
ticket: "ASSETS-10"
status: "completed"
draft: false
weight: 20
---

# ASSETS-10 Contract Freeze

## Depends on
- `ASSETS-00`

## Goal
Зафиксировать полный контракт для загрузки и выгрузки файлов через WebSocket.

## Scope

### Протокол — всё protobuf, нет JSON-фреймов

Контракт определён в `contracts/chat/chat.proto` (package `chat`, не `assets`).
Каждый бинарный WS-фрейм — ровно одно из двух wrapper-сообщений: `ClientFrame` или `ServerFrame` с `oneof payload`. Никаких текстовых/JSON фреймов нет — все сообщения бинарные protobuf.

```protobuf
syntax = "proto3";
package chat;

message ClientFrame {
  oneof payload {
    ClientJoin            join             = 1;
    ClientMessage         message          = 2;
    ClientDelete          delete           = 3;
    ClientUploadStart     upload_start     = 4;
    ClientUploadEnd       upload_end       = 5;
    ClientDownloadRequest download_request = 6;
    UploadChunk           upload_chunk     = 7;
  }
}

message ServerFrame {
  oneof payload {
    ServerJoined        joined         = 1;
    ServerHistory       history        = 2;
    ServerMessage       message        = 3;
    ServerDeleted       deleted        = 4;
    ServerError         error          = 5;
    ServerUploadReady   upload_ready   = 6;
    ServerUploadDone    upload_done    = 7;
    ServerDownloadStart download_start = 8;
    ServerDownloadEnd   download_end   = 9;
    DownloadChunk       download_chunk = 10;
  }
}
```

### Client → Server messages

```protobuf
message ClientJoin {
  string request_id = 1;
  string nickname   = 2;  // 1–32 chars
}

message ClientMessage {
  string request_id = 1;
  string body       = 2;  // 1–200 chars
}

message ClientDelete {
  string request_id = 1;
  int64  message_id = 2;
}

message ClientUploadStart {
  string request_id = 1;
  int64  message_id = 2;
  string filename   = 3;
  uint32 size       = 4;  // declared size, 1..5242880 bytes (5 MB)
  string mime_type  = 5;
}

message ClientUploadEnd {
  string request_id = 1;
  uint32 upload_id  = 2;  // uint32, NOT string/UUID
}

message ClientDownloadRequest {
  string request_id    = 1;
  int64  attachment_id = 2;
}

// Binary chunk of file being uploaded
message UploadChunk {
  uint32 upload_id = 1;  // uint32, NOT string/UUID
  uint32 index     = 2;  // 0-based chunk index
  bytes  data      = 3;  // max CHUNK_SIZE = 64 KB - 32 bytes
}
```

### Server → Client messages

```protobuf
message ServerJoined {
  string request_id  = 1;
  string sender_id   = 2;
  string sender_name = 3;
}

message AttachmentItem {
  int64  id        = 1;
  string filename  = 2;
  int64  size      = 3;
  string mime_type = 4;
}

message ChatItem {
  int64  id          = 1;
  string room_id     = 2;
  string sender_id   = 3;
  string sender_name = 4;
  string body        = 5;
  string created_at  = 6;
  repeated AttachmentItem attachments = 7;
}

message ServerHistory  { repeated ChatItem items = 1; }
message ServerMessage  { ChatItem item = 1; string request_id = 2; }
message ServerDeleted  { int64 message_id = 1; }
message ServerError    { string request_id = 1; string code = 2; string message = 3; }

message ServerUploadReady {
  string request_id = 1;
  uint32 upload_id  = 2;  // uint32 auto-increment per session
}

message ServerUploadDone {
  string request_id    = 1;
  int64  attachment_id = 2;
  string filename      = 3;
  int64  size          = 4;
  string mime_type     = 5;
  int64  message_id    = 6;
}

message ServerDownloadStart {
  string request_id    = 1;
  int64  attachment_id = 2;
  string filename      = 3;
  int64  size          = 4;
  string mime_type     = 5;
  uint32 total_chunks  = 6;
}

message ServerDownloadEnd {
  string request_id    = 1;
  int64  attachment_id = 2;
}

// Binary chunk of file being downloaded
message DownloadChunk {
  int64  attachment_id = 1;  // int64, NOT string
  uint32 index         = 2;
  bytes  data          = 3;
}
```

### Upload state machine
```
ClientUploadStart → [server creates pending upload, upload_id = uint32] → ServerUploadReady
  → N × UploadChunk (binary ClientFrame)
  → ClientUploadEnd → [server persists blob → enforce storage limit] → ServerUploadDone (broadcast to room)
```
- `upload_id` — `uint32`, auto-increment per `UploadSessionState`, scoped to WS session.
- Disconnect drops all pending uploads without DB write.
- Chunks must arrive in order (index 0, 1, 2, …). Out-of-order → `UPLOAD_CHUNK_OUT_OF_ORDER`.
- `upload_end` before all chunks → `UPLOAD_INCOMPLETE`.
- Chunk accumulation exceeds declared `size` → `UPLOAD_TOO_LARGE`.

### Download state machine
```
ClientDownloadRequest → ServerDownloadStart
  → N × DownloadChunk (binary ServerFrame, attachment_id = int64)
  → ServerDownloadEnd
```
- Room-scoped: attachment must belong to a message in the requesting client's room.
- Multiple concurrent downloads from one client are allowed (different attachment IDs).

### Message model — attachments field
`ServerHistory.items` и `ServerMessage.item` содержат `ChatItem` с `repeated AttachmentItem attachments`. Клиент получает метаданные вложений вместе с сообщениями без дополнительных запросов.

### Error codes
| Code | Condition |
|---|---|
| `BAD_PAYLOAD` | Empty frame, oversized frame, or protobuf decode failure |
| `VALIDATION_ERROR` | Invalid nickname, body, message not found on delete, message before join |
| `RATE_LIMITED` | >5 messages per 10s window |
| `CONNECTION_LIMIT_EXCEEDED` | Global WS connection cap (100) reached |
| `UPLOAD_TOO_LARGE` | Declared size > 5 MB, or accumulated chunk data > declared size |
| `UPLOAD_NOT_FOUND` | Unknown `upload_id` |
| `UPLOAD_CHUNK_OUT_OF_ORDER` | `index != pending.next_index` |
| `UPLOAD_INCOMPLETE` | `upload_end` received before all chunks |
| `UPLOAD_LIMIT_EXCEEDED` | Session already has 3 pending uploads |
| `UPLOAD_EXPIRED` | TTL (5 min) exceeded without chunk activity |
| `ATTACHMENT_NOT_FOUND` | Unknown or out-of-room `attachment_id` |
| `INTERNAL_ERROR` | DB or server error |

Note: `DOWNLOAD_NOT_FOUND` from the original design is **not used** — download failures use `ATTACHMENT_NOT_FOUND`.

## Deliverables
- [x] `contracts/chat/chat.proto` — полный контракт (реализовано).
- [x] `contracts/chat/BUILD.bazel` — `proto_library` + `rust_prost_library` таргеты.
- [ ] `contracts/chat/CHAT_CONTRACT.md` — документация с примерами и диаграммой состояний (не написана).

## Отличия от первоначального дизайна
| Дизайн | Реализация |
|---|---|
| `package assets`, файл `contracts/assets/assets.proto` | `package chat`, файл `contracts/chat/chat.proto` |
| Только 2 proto-сообщения (UploadChunk, DownloadChunk) | 17 сообщений — полный протокол в одном файле |
| JSON text frames для управляющих сообщений | Все фреймы бинарные protobuf (`ClientFrame`/`ServerFrame` oneof) |
| `upload_id: string` (UUID) | `upload_id: uint32` (auto-increment per session) |
| `attachment_id: string` в DownloadChunk | `attachment_id: int64` в DownloadChunk |
| `DOWNLOAD_NOT_FOUND` error code | Не реализован — используется `ATTACHMENT_NOT_FOUND` |
| `ASSETS_CONTRACT.md` | Не написан |
| `ts` поле во всех server messages | Отсутствует — timestamp только в `ChatItem.created_at` |

## Tests
- [ ] Schema test: `chat.proto` компилируется без ошибок (`protoc` или `bazel build //contracts/chat:chat_proto`).
- [ ] Contract test: round-trip encode/decode всех сообщений через prost (Rust) и TS-кодек.

## Acceptance
- Backend и frontend используют одни и те же field names, типы и field numbers из `chat.proto`.
- `contracts/chat/chat.proto` — единственный источник правды для wire-формата.
