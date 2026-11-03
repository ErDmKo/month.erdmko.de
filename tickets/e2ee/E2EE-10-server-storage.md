---
title: "Chat E2EE Server Storage"
ticket: "E2EE-10"
status: "planned"
draft: false
weight: 20
---

# E2EE-10 Server Storage: BLOB-миграция и валидация

## Depends on
- `E2EE-00`

## Goal
Хранить body как бинарный блоб, валидировать по байтам с учётом оверхеда
крипты и уничтожить старый plaintext в БД.

## Scope

### Схема (`server/src/chat/db.rs`, `init_chat_schema`, строки 32–67)
- Сейчас: `body TEXT NOT NULL CHECK(length(body) <= 200)` (строка ~51)
- Цель: `body BLOB NOT NULL` + проверка длины **в байтах**:
  `CHECK(length(body) >= 30 AND length(body) <= 1024)`
  (30 = 1 байт версии + 12 nonce + минимум 1 символ шифротекста + 16 тег;
  1024 покрывает plaintext до 200 юникод-символов в худшей UTF-8 кодировке)
- SQLite не умеет `ALTER COLUMN`: нужна пересборка таблицы
  (`CREATE new → INSERT SELECT → DROP old → RENAME`) при обнаружении старой
  схемы через `PRAGMA table_info(messages)`. Определение: тип колонки body
  содержит `TEXT`.
- **Миграция уничтожает содержимое**: старые plaintext-сообщения НЕ
  переносятся (угроза «украли базу» требует их удалить). Переносятся только
  метаданные строк не нужно — таблица пересоздаётся пустой.
  Это осознанное решение, отразить в release notes.

### Валидация (`server/src/chat/db.rs`)
- Заменить `validate_chat_message_body` (строки 69–78) на
  `validate_encrypted_body(body: &[u8]) -> ChatResult<()>`:
  - длина 30..=1024 байт
  - `body[0] == 0x01` (версия конверта; константу вынести в
    `server/src/chat/service.rs` рядом с существующими лимитами)
- Семантическую крипто-валидацию сервер НЕ делает (он не знает ключ).

### Лимиты хранения
- `enforce_messages_storage_limit` (строки 80–106): `SUM(LENGTH(body))` для
  BLOB возвращает байты — работает без изменений кода, проверить тестами.
- `MAX_MESSAGES_STORAGE_BYTES` / `MAX_MESSAGE_LEN` в
  `server/src/chat/service.rs`: переименовать текстовый лимит в
  `MAX_ENCRYPTED_BODY_BYTES = 1024`, обновить тексты ошибок.

### Прочее
- `insert_message` / `get_recent_messages` (строки 172, 291): типы String→Vec<u8>,
  rusqlite параметры/маппинг `&[u8]`/`Vec<u8>`.
- Тесты в `#[cfg(test)]` блоке того же файла переписать на байтовые body.

## Deliverables
- Миграция схемы + функция детекта/пересоздания
- Обновлённые функции insert/get/delete с байтовым body
- Обновлённые unit-тесты

## Tests
- Migration test: старая схема TEXT → пересоздаётся в BLOB, данные очищены,
  новые записи работают
- Unit test: body короче 30 / длиннее 1024 / первый байт != 0x01 отклоняется
- Unit test: граничные значения (ровно 30 и 1024 байт) проходят
- Unit test: лимит хранения обрезает старые сообщения по байтам

## Acceptance
- `bazel test //...` зелёный
- Ручная проверка на живой БД после деплоя: `sqlite3 db.sqlite
  "SELECT body FROM messages LIMIT 5"` показывает бинарные блобы,
  ни одного читаемого текста
