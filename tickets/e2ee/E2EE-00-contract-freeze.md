---
title: "Chat E2EE Contract Freeze"
ticket: "E2EE-00"
status: "planned"
draft: false
weight: 10
---

# E2EE-00 Contract Freeze: body string → bytes

## Depends on
- нет

## Goal
Перевести поле `body` чатовых сообщений с `string` на `bytes` в protobuf-
контракте и перегенерировать код обеих сторон, чтобы по проводу и в БД ехал
сырой шифротекст без base64.

## Scope

### contracts/chat/chat.proto
- `ClientMessage.body` (строка ~54): `string` → `bytes`
- `ChatItem.body` (строка ~106): `string` → `bytes`
- Номера полей НЕ менять (совместимость wire-формата).
- Остальные сообщения контракта не трогать. `UploadChunk.data` уже `bytes`.

### Перегенерация
- Rust: `bazel build //contracts/chat:chat_rs` (prost подхватит изменения при
  сборке сервера автоматически через `server/build.rs`)
- TypeScript: `bazel build //assets/js:chat_ts`, для редакторских копий —
  `npm run gen` (обновит `assets/js/gen/chat.ts`)
- Дескриптор: `server/src/generated/chat.descriptor.json` обновится билдом

### Сопутствующие правки компиляции
После смены типов сломаются места, где body используется как строка:
- сервер: `server/src/chat/db.rs` (`validate_chat_message_body`,
  маппинг строк row → `ChatMessage`), `server/src/pages/chat/dispatch.rs`
  (логирование/валидация)
- фронт: `assets/js/chat/messages/handler.ts` (`renderMessage` передаёт body
  в шаблон), `assets/js/chat/messages/template.ts`

На этом тикете допускается **временная заглушка**: body декодируется как
UTF-8 текст на клиенте и кодируется обратно в UTF-8 байты при отправке
(сквозной транзит). Реальная крипта подключается в E2EE-20/E2EE-30.
Смысл тикета — заморозить новый контракт и починить сборку/тесты.

### Документация
- Обновить `contracts/chat/CHAT_CONTRACT.md`: секции `message` и
  `ChatItem.body` — теперь `bytes`, описать формат конверта (заполняется
  финально в E2EE-20, здесь — тип и ссылка).

## Deliverables
- Изменённый `chat.proto`
- Перегенерированный Rust + TS код
- Сборка зелёная: `bazel build //...`, `bazel test //...`
- Обновлённый `CHAT_CONTRACT.md`

## Tests
- Существующие тесты проходят: `bazel test //...`
- `bazel test //assets/js:chat/protocol.test`
- `./tests/e2e/run.sh suites/chat` (текстовый сценарий отправки сообщения)

## Acceptance
- `ClientFrame` с `message.body` типа bytes принимается живым сервером
  (проверено: скрипт `/tmp/opencode/ws-client.mts` успешно джойнится и
  отправляет сообщения через сгенерированный энкодер)
- Ни один слой не предполагает UTF-8 валидность body
