# ASSETS CONTRACT

Source of truth for file attachment upload/download over WebSocket.

## Key identifiers

| Identifier | Type | Lifetime | Description |
|---|---|---|---|
| `messageId` | integer | permanent | ID of an existing chat message. A file is always attached to a message. Comes from the chat model — must exist before upload starts. |
| `uploadId` | uint32 | temporary | Session-scoped counter assigned by the server in `upload_ready`. Used in `UploadChunk` and `upload_end`. Not stored in the DB — destroyed after `upload_done` or session disconnect. An integer is sufficient because it only needs to be unique within one WS session. |
| `attachmentId` | integer | permanent | ID of a persisted file in the database. Created only after a successful `upload_done`. Used in `download_request` and in the message `attachments` array. |

Lifecycle summary:

```
message { id: 42 }  ← messageId, must exist first
  │
  └─► upload_start { messageId: 42 }
        └─► upload_ready { uploadId: 1 }       ← temporary uint32
              ├─► UploadChunk { uploadId: 1, index: 0 }
              └─► upload_end   { uploadId: 1 }
                    └─► upload_done { attachment: { id: 7, messageId: 42 } }
                                                         ↑
                                                   attachmentId: 7  ← permanent
```

## Transport

| Frame type | Direction | Format |
|---|---|---|
| `upload_start` | Client → Server | JSON text |
| `upload_end` | Client → Server | JSON text |
| `download_request` | Client → Server | JSON text |
| `UploadChunk` | Client → Server | Protobuf binary |
| `upload_ready` | Server → Client | JSON text |
| `upload_done` | Server → Client (broadcast) | JSON text |
| `download_start` | Server → Client | JSON text |
| `DownloadChunk` | Server → Client | Protobuf binary |
| `download_end` | Server → Client | JSON text |

All JSON frames share the existing envelope: `type`, `requestId`, `ts`.
Binary frames are encoded with `assets.proto` (see `assets.proto`).

---

## Protobuf messages

See `assets.proto` for the canonical definitions.

```protobuf
message UploadChunk {
  uint32 upload_id = 1;  // session-scoped upload identifier assigned by server in upload_ready
  uint32 index     = 2;  // 0-based chunk index
  bytes  data      = 3;  // raw file bytes, max 64 KB
}

message DownloadChunk {
  string attachment_id = 1;  // attachment being served
  uint32 index         = 2;  // 0-based chunk index
  bytes  data          = 3;  // raw file bytes, max 64 KB
}
```

---

## JSON frames

### Client → Server

#### `upload_start`

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

| Field | Type | Rules |
|---|---|---|
| `messageId` | integer | required; must reference an existing message in the same room |
| `filename` | string | required, non-empty |
| `size` | integer | required, `1..5242880` (5 MB) |
| `mimeType` | string | required, non-empty (not validated beyond presence in v1) |

#### `upload_end`

```json
{
  "type": "upload_end",
  "requestId": "req-2",
  "uploadId": 1
}
```

| Field | Type | Rules |
|---|---|---|
| `uploadId` | uint32 | required; value returned in `upload_ready` |

#### `download_request`

```json
{
  "type": "download_request",
  "requestId": "req-3",
  "attachmentId": 7
}
```

| Field | Type | Rules |
|---|---|---|
| `attachmentId` | integer | required, positive; must belong to a message in the same room |

---

### Server → Client

#### `upload_ready`

```json
{
  "type": "upload_ready",
  "requestId": "req-1",
  "uploadId": 1,
  "ts": "2024-01-01T00:00:00Z"
}
```

#### `upload_done` (broadcast to room)

```json
{
  "type": "upload_done",
  "requestId": "req-2",
  "uploadId": 1,
  "attachment": {
    "id": 7,
    "messageId": 42,
    "filename": "photo.jpg",
    "size": 204800,
    "mimeType": "image/jpeg"
  },
  "ts": "2024-01-01T00:00:00Z"
}
```

#### `download_start`

```json
{
  "type": "download_start",
  "requestId": "req-3",
  "attachmentId": 7,
  "filename": "photo.jpg",
  "size": 204800,
  "mimeType": "image/jpeg",
  "totalChunks": 4,
  "ts": "2024-01-01T00:00:00Z"
}
```

#### `download_end`

```json
{
  "type": "download_end",
  "requestId": "req-3",
  "attachmentId": 7,
  "ts": "2024-01-01T00:00:00Z"
}
```

---

## Message model extension

`history` and `message` events include an `attachments` array:

```json
{
  "id": 42,
  "roomId": "general",
  "senderId": "anon-7f3a",
  "senderName": "dima",
  "body": "check this out",
  "createdAt": "2024-01-01T00:00:00Z",
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

---

## Upload state machine

```
Client                          Server
  |                               |
  |--- upload_start ------------->|  server creates pending upload
  |<-- upload_ready (uploadId) ---|
  |                               |
  |--- UploadChunk (index=0) ---->|
  |--- UploadChunk (index=1) ---->|
  |--- UploadChunk (index=N) ---->|
  |                               |
  |--- upload_end --------------->|  server persists blob, attaches to message
  |<-- upload_done (broadcast) ---|
```

**Constraints:**
- Pending upload is scoped to the WS session — disconnect cancels it.
- Chunks must arrive in order (`index` 0, 1, 2, …). Out-of-order chunk → `error UPLOAD_CHUNK_OUT_OF_ORDER`.
- `upload_end` before all expected chunks received → `error UPLOAD_INCOMPLETE`.
- Max 3 concurrent pending uploads per session → `error UPLOAD_LIMIT_EXCEEDED`.
- Pending upload TTL: 5 minutes without chunk activity → `error UPLOAD_EXPIRED`.

---

## Error codes

| Code | Trigger |
|---|---|
| `UPLOAD_NOT_FOUND` | Unknown `upload_id` in `UploadChunk` or `upload_end` |
| `UPLOAD_CHUNK_OUT_OF_ORDER` | Chunk `index` does not match expected next index |
| `UPLOAD_INCOMPLETE` | `upload_end` received but chunks are missing |
| `UPLOAD_TOO_LARGE` | Declared `size` exceeds 5 MB, or accumulated chunk data exceeds declared size |
| `UPLOAD_LIMIT_EXCEEDED` | Session already has 3 pending uploads |
| `UPLOAD_EXPIRED` | Pending upload TTL (5 min) exceeded without chunk activity |
| `ATTACHMENT_NOT_FOUND` | Unknown or out-of-room `attachment_id` in `download_request` |
| `DOWNLOAD_NOT_FOUND` | Same as above, in download context |
