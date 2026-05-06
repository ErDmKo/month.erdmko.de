# ASSETS-10 Contract Freeze

## Depends on
- `ASSETS-00`

## Goal
Зафиксировать полный контракт для загрузки и выгрузки файлов через WebSocket.

## Scope

### Protobuf (бинарные фреймы) — `contracts/assets/assets.proto`

```protobuf
syntax = "proto3";
package assets;

// Client → Server: chunk of file being uploaded
message UploadChunk {
  string upload_id = 1;  // UUID assigned by server in upload_ready
  uint32 index     = 2;  // 0-based chunk index
  bytes  data      = 3;  // raw file bytes, max 64 KB
}

// Server → Client: chunk of file being downloaded
message DownloadChunk {
  string attachment_id = 1;  // attachment being served
  uint32 index         = 2;  // 0-based chunk index
  bytes  data          = 3;  // raw file bytes, max 64 KB
}
```

### JSON text frames (existing envelope: `type`, `requestId`, `ts`)

**Client → Server:**

`upload_start`
```json
{
  "type": "upload_start",
  "requestId": "req-1",
  "messageId": 42,
  "filename": "photo.jpg",
  "size": 204800,
  "mimeType": "image/jpeg"
}
```
Rules:
- `messageId`: required, must reference an existing message in the same room
- `filename`: required, non-empty string
- `size`: required, `1..5242880` bytes (5 MB)
- `mimeType`: required, non-empty string (not validated beyond presence in v1)

`upload_end`
```json
{
  "type": "upload_end",
  "requestId": "req-2",
  "uploadId": "uuid"
}
```

`download_request`
```json
{
  "type": "download_request",
  "requestId": "req-3",
  "attachmentId": 7
}
```
Rules:
- `attachmentId`: required, positive integer, must belong to a message in the same room

**Server → Client:**

`upload_ready`
```json
{
  "type": "upload_ready",
  "requestId": "req-1",
  "uploadId": "uuid",
  "ts": "..."
}
```

`upload_done` (broadcast to room)
```json
{
  "type": "upload_done",
  "requestId": "req-2",
  "uploadId": "uuid",
  "attachment": {
    "id": 7,
    "messageId": 42,
    "filename": "photo.jpg",
    "size": 204800,
    "mimeType": "image/jpeg"
  },
  "ts": "..."
}
```

`download_start`
```json
{
  "type": "download_start",
  "requestId": "req-3",
  "attachmentId": 7,
  "filename": "photo.jpg",
  "size": 204800,
  "mimeType": "image/jpeg",
  "totalChunks": 4,
  "ts": "..."
}
```

`download_end`
```json
{
  "type": "download_end",
  "requestId": "req-3",
  "attachmentId": 7,
  "ts": "..."
}
```

### Message model extension
`history` и `message` events расширяются полем `attachments`:
```json
{
  "id": 42,
  "roomId": "general",
  "senderId": "anon-7f3a",
  "senderName": "dima",
  "body": "check this out",
  "createdAt": "...",
  "attachments": [
    {
      "id": 7,
      "filename": "photo.jpg",
      "size": 204800,
      "mimeType": "image/jpeg"
    }
  ]
}
```

### Upload state machine
```
upload_start → [server creates pending upload] → upload_ready
  → N × UploadChunk (binary)
  → upload_end → [server persists blob, attaches to message] → upload_done (broadcast)
```
- Pending upload is scoped to the WS session — disconnect cancels it.
- Chunks must arrive in order (index 0, 1, 2, ...). Out-of-order chunk → `error UPLOAD_CHUNK_OUT_OF_ORDER`.
- `upload_end` before all expected chunks received → `error UPLOAD_INCOMPLETE`.

### Error codes (new)
- `UPLOAD_NOT_FOUND` — unknown `upload_id`
- `UPLOAD_CHUNK_OUT_OF_ORDER` — chunk index does not match expected
- `UPLOAD_INCOMPLETE` — `upload_end` received but chunks missing
- `UPLOAD_TOO_LARGE` — declared `size` exceeds 5 MB or accumulated chunk data exceeds declared size
- `UPLOAD_LIMIT_EXCEEDED` — session already has 3 pending uploads
- `UPLOAD_EXPIRED` — pending upload TTL (5 min) exceeded without chunk activity
- `ATTACHMENT_NOT_FOUND` — unknown or out-of-room `attachment_id`
- `DOWNLOAD_NOT_FOUND` — same as above, download context

## Deliverables
- `contracts/assets/assets.proto` finalised.
- `contracts/assets/ASSETS_CONTRACT.md` with full examples and state machine diagram.

## Tests
- Schema test: proto file compiles with `protoc` without errors.
- Contract test: all JSON examples parse against their field definitions.

## Acceptance
- Backend и frontend используют одни и те же field names и типы.
- `.proto` и `ASSETS_CONTRACT.md` не противоречат друг другу.
- Источник правды: `contracts/assets/`.
