# Assets Tickets

Source: discussion + `contracts/assets/`

## Execution Order

1. `ASSETS-00` Foundation
2. `ASSETS-10` Contract Freeze
3. `ASSETS-20` Data Layer
4. `ASSETS-30` WebSocket Protocol
5. `ASSETS-40` UI
6. `ASSETS-50` Stability & Security

## Dependency Map

- `ASSETS-00` → none
- `ASSETS-10` → `ASSETS-00`
- `ASSETS-20` → `ASSETS-10`
- `ASSETS-30` → `ASSETS-20`
- `ASSETS-40` → `ASSETS-30`
- `ASSETS-50` → `ASSETS-40`

## Ticket Files

- `ASSETS-00-foundation.md`
- `ASSETS-10-contract-freeze.md`
- `ASSETS-20-data-layer.md`
- `ASSETS-30-ws-protocol.md`
- `ASSETS-40-ui.md`
- `ASSETS-50-stability.md`

## Key Design Decisions

- **Storage**: SQLite `attachments` table, `data BLOB`, FK → `messages(id)` CASCADE DELETE.
- **Transport**: WS chunked. JSON text frames for all control messages. Protobuf binary frames for `UploadChunk` / `DownloadChunk` only.
- **Proto contract**: `contracts/assets/assets.proto` — source of truth for binary protocol.
- **TS serializer**: hand-written for v1 (`assets/js/chat/attachments-proto.ts`). Migration to `@bufbuild/protobuf` deferred until all binary messages use proto.
- **Rust codegen**: `prost` + `prost-build` via `server/build.rs`.
- **Per-file limit**: 5 MB hard cap enforced at `upload_start` and per-chunk accumulation.
- **Total storage**: 1 GB cap, eviction by `created_at ASC` (oldest first).
- **Lifecycle**: delete message → attachments deleted (CASCADE). Delete room → messages deleted → attachments deleted.
- **Access**: same room-scoped rules as chat messages. No additional auth in v1.
- **Chunk size**: 64 KB per `UploadChunk` / `DownloadChunk`.
- **Pending uploads**: in-memory per WS session, discarded on disconnect, never written to DB unless `upload_end` succeeds.
