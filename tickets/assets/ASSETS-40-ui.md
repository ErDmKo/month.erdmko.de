---
title: "Assets UI"
ticket: "ASSETS-40"
status: "completed"
draft: false
weight: 50
---

# ASSETS-40 UI

## Depends on
- `ASSETS-30`

## Goal
Добавить в интерфейс чата поддержку прикрепления файлов к сообщениям и их скачивания.

## Scope

### Attach file to message
- Кнопка "Attach" рядом с composer — открывает `<input type="file">`.
- После выбора файла: валидация размера ≤ 5 MB на клиенте, показать имя файла и размер в preview-области над composer.
- Возможность убрать выбранный файл до отправки (кнопка ×).
- При submit формы сообщения:
  1. Отправить `message` (JSON) → получить `message_id` из события `message`.
  2. Если файл прикреплён — запустить upload flow (`upload_start` → chunks → `upload_end`).
- Индикатор прогресса загрузки: `X / N chunks sent`.

### Attachment in message list
- Каждое сообщение с вложениями показывает список прикреплённых файлов под текстом.
- Для каждого вложения: иконка, имя файла, размер (human-readable: KB/MB).
- Кнопка "Download" на каждом вложении — запускает download flow.
- Индикатор прогресса скачивания: `X / N chunks received`.
- По завершению `download_end` — браузерный download через `URL.createObjectURL(blob)`.

### History
- `history` event теперь включает `attachments` в каждом сообщении — рендерятся сразу при загрузке.

### Actual module layout (as implemented)

Templates распределены по субдиректориям, отдельной папки `template/` нет:
- `assets/js/chat/chat-ui/template.ts` — `chatUiTemplate`, `mountChatUi`, `CHAT_REF_*` константы (0–14), включая `CHAT_REF_ATTACH_BUTTON=12`, `CHAT_REF_FILE_INPUT=13`, `CHAT_REF_UPLOAD_PREVIEW=14`
- `assets/js/chat/messages/template.ts` — `chatMessageTemplate`, `MESSAGE_REF_ATTACHMENTS=0`, тип `MessageRefs`
- `assets/js/chat/attachments/template.ts` — `attachmentItemTemplate`, `uploadPreviewTemplate`, `ATTACHMENT_REF_PROGRESS=0`, `UPLOAD_PREVIEW_REF_REMOVE=0`, `UPLOAD_PREVIEW_REF_PROGRESS=1`

Upload и download логика объединены в `assets/js/chat/attachments/handler.ts` (отдельных `upload.ts` и `download.ts` нет).

Protocol разбит на:
- `assets/js/chat/protocol/incoming.ts` — `parseBinaryFrame`, `BaseChatSocket`, `ChatSocket`
- `assets/js/chat/protocol/outgoing.ts` — `serializeCommand`, `validateOutgoingCommand`
- `assets/js/chat/generated/chat.ts` — полный protobuf-кодек (все типы и encode/decode функции)

Вспомогательные утилиты:
- `assets/js/utils/proto-utils.ts` — низкоуровневая protobuf wire-format библиотека (varint, Reader, field encoders)
- `assets/js/utils/ws-logger.ts` — debug-логгер WebSocket фреймов (включается через `localStorage.debug`)

### State
`assets/js/chat/index.ts` — точка входа, монтирует три подсистемы в Task pipeline: `initChatUi` → `initMessages` → `initAttachments`.

`assets/js/chat/chat-ui/` — состояние и события UI:
- `state.ts` — `ChatUiState` tuple: `[isJoined, joinInFlight, isOnline]`
- `events.ts` — `ChatUiEvent`: `CHAT_UI_INIT`, `CHAT_UI_ERROR`, `CHAT_UI_JOINED`, `CHAT_UI_FILE_SELECTED`

`assets/js/chat/attachments/init.ts`:
- `pendingFile` хранится в замыкании через `fileInput.files[0]` на момент submit
- Download per-attachment через `createStore<DownloadEvent | null>(null)`
- Upload координация через `makeWaitForMessageId(wsEventState): (requestId) => Task<number>` из `messages/handler.ts`

## Deliverables
- `assets/js/chat/chat-ui/`, `messages/`, `attachments/` — субмодули с логикой и шаблонами (реализовано).
- `assets/js/chat/protocol/` + `generated/chat.ts` — protobuf протокол (реализовано).
- `assets/js/chat/index.ts` — точка входа, Task pipeline (реализовано).
- `assets/js/utils/proto-utils.ts`, `ws-logger.ts` — новые утилиты (реализовано).
- `contracts/chat/chat.proto` + `BUILD.bazel` — контракт и Bazel таргет для Rust (реализовано).
- Сервер: `message_payload` и `history_payload` включают `attachments` (реализовано).

## Tests
- [ ] UI smoke: кнопка Attach видна в chat screen.
- [ ] File select: выбор файла показывает preview с именем и размером.
- [ ] File remove: кнопка × убирает preview, сбрасывает pendingFile.
- [ ] Size validation: файл >5 MB показывает ошибку, upload не стартует.
- [ ] Upload progress: индикатор обновляется по мере отправки чанков.
- [ ] upload_done: вложение появляется в сообщении в списке.
- [ ] Download button: клик на Download запускает download flow.
- [ ] Download progress: индикатор обновляется по мере получения чанков.
- [ ] download_end: браузерный download запускается с правильным именем файла.
- [ ] History render: сообщения из `history` с вложениями рендерят attachment секцию.

## Acceptance
- Пользователь может прикрепить файл ≤ 5 MB к сообщению и отправить.
- Второй клиент видит вложение через `upload_done` и может скачать его.
- История загружается с метаданными вложений без дополнительных действий.

## TODO
- [x] Разбить `protocol.ts` на модули: `protocol/incoming.ts`, `protocol/outgoing.ts`, `generated/chat.ts`
- [x] Template: `chatMessageTemplate`, `attachmentItemTemplate`, `uploadPreviewTemplate`, новые ref-константы
- [x] UI: attach button, file input, preview с кнопкой ×, валидация размера
- [x] UI: upload flow — запуск после отправки message
- [x] UI: attachment list в сообщениях, download button, индикатор прогресса скачивания, blob download
- [x] UI: history — рендер вложений из `attachments` в history event
- [x] **BUG fix: download давал 0 байт** — `startDownload` в `attachments/handler.ts` теперь ждёт `totalChunks` чанков И флага `endSeen` перед сборкой blob. `download_end` больше не обгоняет бинарные чанки.
- [ ] **BUG: upload progress не отображается** — `startUpload()` возвращает `ObserverInstance<UploadEvent>`, но в `attachments/init.ts` этот observer не подписан. Спан `UPLOAD_PREVIEW_REF_PROGRESS` в preview-шаблоне никогда не обновляется.
- [ ] Написать тесты (список выше)
