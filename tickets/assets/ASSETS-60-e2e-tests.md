# ASSETS-60 E2E Integration Tests

## Depends on
- `ASSETS-50`

## Goal
Покрыть полный flow загрузки и скачивания файлов сквозными тестами: сервер + браузер (Puppeteer).

Существующие unit/integration тесты (`server/src/pages/chat/tests/`) тестируют сервер in-process через `awc` WebSocket client.
Этот тикет добавляет e2e-слой: реальный собранный сервер + настоящий браузер через Puppeteer.

## Scope

### Test runner setup (`tests/e2e/`)
- `package.json` с dev-зависимостями: `jest`, `ts-jest`, `puppeteer`, `ws` (native WS client для non-browser тестов).
- `tsconfig.json` — `module: CommonJS`, `target: ES2020`, `strict: true`.
- `jest.config.ts` — `testEnvironment: node`, `testTimeout: 30000`, `globalSetup` / `globalTeardown` для сборки и запуска сервера.
- Вспомогательный скрипт `helpers/server.ts`:
  - Сборка `bazel build //server:server` (не `cargo build` — см. ниже).
  - Запуск на случайном порту через env-переменные `HOST` и `PORT`.
  - Изоляция БД: создаётся tmp-`BASE_PATH` с симлинками на read-only `templates/` и `assets/` из runfiles плюс свежий `server/db/`.
  - Ожидание readiness по первому успешному TCP-connect.
  - `stop()` — `SIGTERM` + удаление tmp-`BASE_PATH`.
- `helpers/ws-client.ts` — обёртка над `ws` для отправки JSON-команд и чтения text/binary фреймов с timeout.
- `helpers/proto.ts` — `encodeUploadChunk(uploadId, index, data)` и `extractDownloadChunk(buf)` (портированы из `server/src/pages/chat/tests/helpers.rs`).

### Test suites

#### `chat.test.ts` — базовый smoke
- Сервер стартует, WebSocket принимает соединения.
- `join` → `joined` + `history` (пустая история).
- Два клиента в одной комнате: один отправляет `message`, второй получает broadcast.

#### `attachments.test.ts` — upload/download через WS-client (без браузера)
- Happy path upload: `upload_start` → chunk → `upload_end` → `upload_done`.
- Happy path download: `download_request` → `download_start` → binary chunks → `download_end`; собранные данные совпадают с исходными.
- `upload_done` бродкастится всем клиентам комнаты.
- Ошибочные сценарии (покрыты отдельно от Rust-тестов как sanity через реальный бинарник):
  - `UPLOAD_TOO_LARGE` при `size > 5 MB`.
  - `UPLOAD_LIMIT_EXCEEDED` при 4-м одновременном upload.
  - `UPLOAD_CHUNK_OUT_OF_ORDER`.
  - `ATTACHMENT_NOT_FOUND` при download из чужой комнаты.

#### `attachments-ui.test.ts` — полный browser E2E (Puppeteer)
- Открыть страницу чата в браузере (`page.goto`).
- Ввести nickname, нажать Join.
- Ввести текст сообщения, выбрать файл через `page.setInputFiles(fileInputSelector, filePath)`.
- Submit — дождаться появления attachment в списке сообщений (имя файла в DOM).
- Нажать Download на вложении — дождаться `download_end` через `page.waitForFunction`.
- Проверить, что индикатор прогресса появлялся (`X / N chunks sent`).
- Проверить кнопку удаления файла из preview до отправки.

### CI integration
- Скрипт `tests/e2e/run.sh`:
  ```sh
  cd $(git rev-parse --show-toplevel)
  bazel build //server:server
  cd tests/e2e && npm ci && npx jest "$@"
  ```
- В README добавить секцию `## E2E tests`.

## Actual module layout (as implemented)

```
tests/e2e/
├── package.json
├── tsconfig.json
├── jest.config.ts
├── run.sh
├── helpers/
│   ├── server.ts       # ServerHandle: build + spawn + wait-ready + stop
│   ├── ws-client.ts    # WsClient: connect, sendText, sendBinary, nextText, nextBinary, close
│   └── proto.ts        # encodeUploadChunk, extractDownloadChunk (binary proto helpers)
└── suites/
    ├── chat.test.ts
    ├── attachments.test.ts
    └── attachments-ui.test.ts
```

## Key decisions
- **`bazel build //server:server`, не `cargo build`** — бинарник компилируется с `option_env!("BAZEL_STATIC") = Some("server")`, что меняет логику поиска статики и шаблонов. `cargo build` даёт бинарник с `BAZEL_STATIC = None`, который ищет `static/` вместо `assets/` и не найдёт Tera-шаблоны. Кроме того, `//contracts/chat:chat_rs` — это Bazel-generated prost-крейт; `cargo` не может его собрать.
- **DB isolation через tmp BASE_PATH** — сервер игнорирует гипотетический `DB_PATH` env var; путь к БД захардкожен как `{BASE_PATH}/server/db/main.db`. Решение: создаём temp-директорию с симлинками на read-only `templates/` и `assets/` из runfiles и свежим `server/db/`. Очищается при `stop()`.
- Сервер используется как реальный бинарник из `bazel-bin/server/server`, не in-process — это настоящий e2e, не просто integration.
- WS-client тесты (`chat.test.ts`, `attachments.test.ts`) не требуют браузера — быстрее и стабильнее.
- Puppeteer тест (`attachments-ui.test.ts`) тестирует именно браузерный JS, включая progress-индикатор и download-flow через `URL.createObjectURL`.
- `page.setInputFiles` используется вместо эмуляции клика на `<input>` — надёжнее в headless-окружении.

## Deliverables
- [ ] `tests/e2e/package.json`
- [ ] `tests/e2e/tsconfig.json`
- [ ] `jest.config.ts`
- [ ] `tests/e2e/helpers/server.ts`
- [ ] `tests/e2e/helpers/ws-client.ts`
- [ ] `tests/e2e/helpers/proto.ts`
- [ ] `tests/e2e/suites/chat.test.ts`
- [ ] `tests/e2e/suites/attachments.test.ts`
- [ ] `tests/e2e/suites/attachments-ui.test.ts`
- [ ] `tests/e2e/run.sh`
