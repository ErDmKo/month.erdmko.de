# ASSETS-00 Foundation

## Depends on
- none (parallel to chat, but assumes chat module structure exists)

## Goal
Подготовить каркас для работы с файловыми вложениями: константы, пустые модули, заглушки роутов.

## Scope
- Добавить константы:
  - `MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024` (5 MB per file)
  - `MAX_ATTACHMENTS_STORAGE_BYTES = 1024 * 1024 * 1024` (1 GB total)
  - `ATTACHMENT_CHUNK_SIZE = 64 * 1024` (64 KB)
  - `MAX_ATTACHMENTS_PER_MESSAGE = 10`
- Создать пустой модуль `server/src/attachments/` с подмодулями `db`, `error`, `service`.
- Добавить `.proto` файл `contracts/assets/assets.proto` с определениями `UploadChunk` и `DownloadChunk`.
- Подключить `prost` и `prost-build` в `server/Cargo.toml` и `server/build.rs`.

## Deliverables
- `contracts/assets/assets.proto` с двумя message-определениями.
- `server/src/attachments/mod.rs` — пустой модуль, компилируется без ошибок.
- `server/build.rs` — codegen из `.proto` через `prost-build`.
- Сборка проекта проходит.

## Tests
- Build test: `bazel build //...` / `cargo check` проходит.
- Proto codegen test: сгенерированные типы `UploadChunk` и `DownloadChunk` доступны в Rust.

## Acceptance
- Проект собирается с новыми зависимостями и модулями.
- `.proto` файл является источником правды для бинарного протокола.
