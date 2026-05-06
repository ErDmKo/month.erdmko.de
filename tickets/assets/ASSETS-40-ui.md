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

### Template changes
`assets/js/chat/template.ts`:
- Обновить `chatMessageTemplate` — добавить секцию вложений.
- Добавить `attachmentItemTemplate(id, filename, size, mimeType)` — один файл в списке.
- Добавить `uploadPreviewTemplate(filename, size)` — preview над composer.
- Новые ref-константы: `CHAT_REF_ATTACH_BUTTON`, `CHAT_REF_FILE_INPUT`, `CHAT_REF_UPLOAD_PREVIEW`.

### State
`assets/js/chat/index.ts`:
- Хранить `pendingFile: File | null` — выбранный но ещё не загруженный файл.
- Хранить `activeDownloads: Map<number, DownloadState>` — текущие скачивания.
- Хранить `activeUpload: UploadState | null` — текущая загрузка (одна за раз в v1).

## Deliverables
- Обновлённые `assets/js/chat/template.ts` и `assets/js/chat/index.ts`.
- `assets/js/chat/upload.ts` и `assets/js/chat/download.ts` подключены к UI.

## Tests
- UI smoke: кнопка Attach видна в chat screen.
- File select: выбор файла показывает preview с именем и размером.
- File remove: кнопка × убирает preview, сбрасывает `pendingFile`.
- Size validation: файл >5 MB показывает ошибку, upload не стартует.
- Upload progress: индикатор обновляется по мере отправки чанков.
- upload_done: вложение появляется в сообщении в списке.
- Download button: клик на Download запускает download flow.
- Download progress: индикатор обновляется по мере получения чанков.
- download_end: браузерный download запускается с правильным именем файла.
- History render: сообщения из `history` с вложениями рендерят attachment секцию.

## Acceptance
- Пользователь может прикрепить файл ≤ 5 MB к сообщению и отправить.
- Второй клиент видит вложение через `upload_done` и может скачать его.
- История загружается с метаданными вложений без дополнительных действий.
