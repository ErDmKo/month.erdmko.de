---
title: "Chat E2EE Attachments"
ticket: "E2EE-40"
status: "planned"
draft: false
weight: 50
---

# E2EE-40 Attachments: шифрование файлов

## Depends on
- `E2EE-30`

## Goal
Файлы (картинки/вложения) шифруются на клиенте до нарезки на чанки; сервер
хранит блоб, который не может открыть.

## Scope

### Payload конверта вложения (`assets/js/chat/crypto/envelope.ts`)
Расширить модуль потоковой функцией для больших файлов:
```
file envelope = [0x01] [nonce 12] [ len(meta) u32 LE ] [ encrypted meta json ] [ file ciphertext ]
```
- `meta = {"name": "...", "type": "image/png"}` — оригинальные имя и mime,
  шифруются тем же ключом (AAD = `month:e2ee:v1:att:${slug}`)
- Весь payload (мета + содержимое) шифруется ОДНИМ AES-GCM вызовом целиком:
  файл читается в память (лимит вложений сервера и так небольшой — уточнить
  константу в `server/src/attachments/service.rs`; если стриминг обязателен,
  разбить на per-chunk AES-GCM с counter-nonce — решить при имплементации,
  предпочтение цельному конверту)

### Upload path (`assets/js/chat/attachments/handler.ts`, `init.ts`)
- До `upload_start`: зашифровать файл → отправлять как один блоб
- `ClientUploadStart.filename = "enc.bin"`, `mime_type =
  "application/octet-stream"` (оригиналы утекают в meta внутри конверта)
- Размер, передаваемый в upload_start = размеру конверта

### Download path
- После получения всех chunk'ов: распарсить конверт, decryptBody → Blob с
  оригинальным name/mime из меты → рендер как сейчас (`renderAttachment`)
- Ошибка расшифровки → плейсхолдер 🔒 вместо превью

### Сервер
- Изменений по сути нет: чанки уже байты. Проверить только, что лимиты
  размеров учитывают +29 байт оверхеда и что валидация mime на сервере
  (если есть) пропускает `application/octet-stream`.

## Deliverables
- Расширенный crypto-модуль (attachment envelope + тесты)
- Переделанные upload/download ветки клиента

## Tests
- Unit: roundtrip файла 0 байт / 1 МБ; tamper → отказ; чужой ключ → отказ
- Unit: мета содержит имя/mime, наружу не утекают (проверка полей
  upload_start)
- Integration e2e: A загружает png, B видит картинку; C с неверной фразой
  видит 🔒
- Ручная проверка БД/диска сервера: файл вложения не открывается как png

## Acceptance
- Вложения работают end-to-end у участников с фразой
- На диске сервера нет ни содержимого файлов, ни их имён
