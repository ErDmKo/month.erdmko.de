# MVP Plan: Room Chat (Text Only)

## 1. Goal

Сделать простой чат с комнатами, где 2+ пользователя обмениваются только текстовыми сообщениями до 200 символов в реальном времени.

## 2. MVP Scope

Входит в MVP:
- Комнаты по `room_id` (join/create по ссылке или коду).
- 2+ участников в одной комнате.
- Отправка/получение текстовых сообщений в реальном времени.
- Ограничение длины сообщения: `1..200` символов.
- Базовая история сообщений в комнате (последние N, например 50).
- Простая идентификация пользователя (временный nickname или user_id в сессии).

Не входит в MVP:
- Файлы, картинки, голос, реакции.
- Редактирование/удаление сообщений.
- Приватные диалоги 1:1 вне комнаты.
- Сквозное шифрование.
- Сложная модерация/антиспам.

## 3. Functional Requirements

- Пользователь может открыть комнату по URL `/chat/{room_id}`.
- Пользователь может перейти в чат с текущей главной страницы `/`.
- Пользователь видит список сообщений комнаты.
- Пользователь отправляет сообщение и все участники комнаты получают его без перезагрузки страницы.
- Сервер отбрасывает сообщения длиннее 200 символов.
- Пустые/пробельные сообщения не принимаются.
- При переподключении пользователь снова получает историю комнаты.

## 4. Non-Functional Requirements

- Задержка доставки сообщения: целевой p95 < 1 сек в рамках одного региона.
- Надежность: при перезапуске сервера история не теряется (SQLite).
- Безопасность (минимум для MVP):
  - Валидация входных данных на сервере.
  - Экранирование вывода в UI (без XSS).
  - Ограничение размера payload для WebSocket сообщений.

## 5. User Flow

1. Пользователь открывает `/chat/{room_id}`.
2. Клиент подключается к WebSocket endpoint.
3. Клиент отправляет `join` событие с `nickname`.
4. Сервер отвечает историей комнаты.
5. Пользователь отправляет текст.
6. Сервер валидирует, сохраняет, рассылает всем в комнате.

## 6. Suggested Architecture (for current Rust repo)

- Backend: Actix Web + Actix WebSocket.
- Storage: SQLite (`rooms`, `users`, `messages`).
- Frontend: server-side template + JS WebSocket client.
- Endpoint:
  - Page: `GET /chat/{room_id}`
  - Socket: `GET /ws/chat/{room_id}`

## 7. Data Model (MVP)

`rooms`
- `id` TEXT PRIMARY KEY
- `created_at` DATETIME

`users` (упрощенно, можно без таблицы на MVP-1)
- `id` TEXT PRIMARY KEY
- `nickname` TEXT NOT NULL
- `created_at` DATETIME

`messages`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `room_id` TEXT NOT NULL
- `sender_id` TEXT NOT NULL
- `sender_name` TEXT NOT NULL
- `body` TEXT NOT NULL CHECK(length(body) <= 200)
- `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP

Индексы:
- `messages(room_id, created_at)`

## 8. API/WS Contract (JSON)

### 8.1 HTTP Endpoints

`GET /chat/{room_id}`
- Назначение: отдать HTML страницу комнаты.
- Path params:
- `room_id`: `[a-zA-Z0-9_-]{1,64}`
- Response: `200 text/html`

`GET /ws/chat/{room_id}`
- Назначение: WebSocket handshake для комнаты.
- Path params:
- `room_id`: `[a-zA-Z0-9_-]{1,64}`
- Response: upgrade to WebSocket (`101 Switching Protocols`)

### 8.2 Message Envelope

Все WS-сообщения передаются JSON с полем `type`.

Общий формат:
- `type`: string
- `requestId`: string (optional, для корреляции ответа на клиентский запрос)
- `ts`: string (ISO8601, выставляет сервер в исходящих событиях)

### 8.3 Client -> Server Events

`join`
```json
{
  "type": "join",
  "requestId": "req-1",
  "nickname": "dima"
}
```

Правила:
- Комната определяется только из URL соединения `/ws/chat/{room_id}`.
- `nickname` обязателен, `1..32` символа после trim.

`message`
```json
{
  "type": "message",
  "requestId": "req-2",
  "body": "hello team"
}
```

Правила:
- `body` обязателен, `1..200` символов после trim.
- Пустое или >200 символов -> ошибка валидации.

### 8.4 Server -> Client Events

`joined`
```json
{
  "type": "joined",
  "requestId": "req-1",
  "self": {
    "senderId": "anon-7f3a",
    "senderName": "dima"
  },
  "ts": "2026-03-23T07:00:00Z"
}
```

`history`
```json
{
  "type": "history",
  "items": [
    {
      "id": 101,
      "roomId": "general",
      "senderId": "anon-4fa1",
      "senderName": "anna",
      "body": "hi",
      "createdAt": "2026-03-23T06:59:50Z"
    }
  ],
  "ts": "2026-03-23T07:00:00Z"
}
```

`message`
```json
{
  "type": "message",
  "item": {
    "id": 102,
    "roomId": "general",
    "senderId": "anon-7f3a",
    "senderName": "dima",
    "body": "hello team",
    "createdAt": "2026-03-23T07:00:10Z"
  },
  "ts": "2026-03-23T07:00:10Z"
}
```

`error`
```json
{
  "type": "error",
  "requestId": "req-2",
  "code": "VALIDATION_ERROR",
  "message": "Message must be between 1 and 200 characters.",
  "details": {
    "field": "body",
    "reason": "MESSAGE_TOO_LONG",
    "max": 200
  },
  "ts": "2026-03-23T07:00:11Z"
}
```

### 8.5 Error Codes

- `VALIDATION_ERROR`
- `BAD_PAYLOAD`
- `UNSUPPORTED_EVENT_TYPE`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

### 8.6 Ordering and Delivery Rules (MVP)

- Порядок сообщений в комнате определяется сервером по `id` и `createdAt`.
- Сервер делает broadcast только после успешного сохранения в БД.
- At-most-once семантика для MVP (без retry-ack протокола).
- При reconnect клиент повторно делает `join` и получает `history`.

### 8.7 Limits

- Max длина `nickname`: 32.
- Max длина `body`: 200.
- Max размер входящего WS payload: 4KB.
- История по умолчанию: последние 50 сообщений.

### 8.8 Security Rules

- Сервер валидирует все входящие поля независимо от клиентской валидации.
- Любая невалидная команда -> только `error` отправителю, без broadcast.
- Текст сообщения хранится как plain text.
- На клиенте рендер только через безопасный текстовый вывод (`textContent`).

## 9. Delivery Plan (Implementation Steps)

### Frontend Track (детализация)

Цель фронтенда:
- Дать пользователю простой и быстрый UI для комнаты: зайти, увидеть историю, отправить сообщение, видеть новые сообщения без reload.

Frontend-артефакты:
- Шаблон страницы: `server/templates/chat.html`
- Клиентский скрипт: `assets/js/chat/index.ts` (или аналогичный модуль)
- Стили чата: `assets/css/style.scss` (новый блок `.chat-*`)
- Интеграция на главной: `server/templates/main.html` + `server/src/pages/main_page.rs`

Frontend UI-компоненты:
- Header комнаты: room id + статус соединения (`connecting`, `online`, `offline`)
- Message list: сообщения с `sender_name`, `time`, `body`
- Composer: nickname, message input/textarea, send button
- Counter: `0/200`, предупреждение при приближении к лимиту
- Error area: серверные и клиентские ошибки

Frontend-события:
- `page_load`: подключение к `/ws/chat/{room_id}`
- `ws_open`: отправка `join`
- `ws_history`: первичный рендер истории
- `ws_message`: append нового сообщения
- `submit`: local validation и отправка `message`
- `ws_error/ws_close`: переключение UI в состояние ошибки/оффлайн

Frontend-валидации:
- `nickname`: 1..32 символа
- `message`: trim + 1..200 символов
- disabled send при невалидном вводе
- безопасный рендер текста только через `textContent`

Frontend UX:
- `Enter` отправляет, `Shift+Enter` новая строка
- автоскролл вниз при новых сообщениях (если пользователь уже внизу)
- адаптивность для mobile (320px+)

Frontend Acceptance:
- пользователь может открыть чат с главной страницы и отправить сообщение за 1-2 действия
- history рендерится при входе в комнату
- realtime обновления работают без перезагрузки
- лимит 200 символов виден и соблюдается в UI

### Этап 0: Project Setup (0.5 дня)
- Создать ветку разработки под MVP.
- Зафиксировать структуру модулей для чата (`pages/chat`, `ws/chat`, `db/chat`).
- Добавить конфиг-константы: `MAX_MESSAGE_LEN=200`, `HISTORY_LIMIT=50`.
- Критерий завершения: проект собирается, новые модули подключены пустыми заглушками.

### Этап 1: Data Layer (0.5-1 день)
- Добавить таблицы `rooms` и `messages`.
- Добавить индекс `messages(room_id, created_at)`.
- Реализовать функции:
- `create_room_if_not_exists(room_id)`
- `insert_message(room_id, sender_id, sender_name, body)`
- `get_recent_messages(room_id, limit)`
- Добавить валидацию длины и пустого текста на сервере.
- Критерий завершения: функции БД работают и покрыты базовыми unit/smoke тестами.

### Этап 2: WebSocket Room Hub (1 день)
- Реализовать room registry в памяти: `room_id -> connections`.
- Реализовать обработку событий:
- `join` -> join room + отправка history.
- `message` -> validate + save + broadcast.
- Добавить обработку disconnect и cleanup пустых комнат.
- Критерий завершения: два клиента в одной комнате получают сообщения друг друга в real-time.

### Этап 3: HTTP + UI Integration (1 день)
- Добавить страницу `GET /chat/{room_id}`.
- Добавить фронтенд-скрипт для подключения к `GET /ws/chat/{room_id}`.
- Реализовать форму отправки:
- nickname input.
- message input.
- счетчик `0/200` и блокировка отправки невалидного текста.
- Реализовать рендер истории и новых сообщений.
- Критерий завершения: UI позволяет join/send/receive без перезагрузки.

### Этап 4: Интеграция с текущей главной страницей (0.5 дня)
- Добавить на главной (`/`) новый блок/ссылку на чат.
- Добавить entry-point:
- ссылка вида `/chat/general` для быстрого входа.
- (опционально) мини-форма "Room ID" + переход на `/chat/{room_id}`.
- Обновить контекст главной страницы (`main_page.rs`) и шаблон (`main.html`) без ломки существующих секций.
- Критерий завершения: пользователь может открыть чат напрямую с главной страницы за 1 клик.

### Этап 5: Stability & Security Baseline (0.5 дня)
- Ограничить размер входящего WS payload.
- Добавить простой rate limit на соединение (например, 5 msg / 10 сек).
- Экранировать пользовательский текст на выводе в UI.
- Добавить structured logging для join/message/error/disconnect.
- Критерий завершения: невалидные payload не ломают соединение, ошибки обрабатываются штатно.

### Этап 6: QA / Smoke / Release (0.5 дня)
- Смоук-тест: 2-3 клиента в одной комнате.
- Проверка валидации: пустое сообщение, 201+ символ.
- Проверка восстановления: перезапуск сервера + наличие истории.
- Проверка интеграции: переход в чат с главной страницы работает.
- Обновить README с инструкцией запуска чата.
- Критерий завершения: все acceptance criteria из секции 10 выполнены.

### Milestones
- M1 (после Этапа 1): готова БД и запись/чтение сообщений.
- M2 (после Этапа 2): работает real-time обмен в WS.
- M3 (после Этапа 3): готов пользовательский MVP-интерфейс.
- M4 (после Этапа 4): есть вход в чат с главной страницы.
- M5 (после Этапов 5-6): стабилизированный MVP готов к использованию.

## 10. Acceptance Criteria

- Два клиента в одной комнате получают сообщения друг друга в реальном времени.
- Сообщения > 200 символов отвергаются сервером.
- История последних сообщений подгружается при подключении.
- Ошибки валидации отображаются пользователю.
- Функциональность работает локально без внешних SaaS.

## 11. Risks

- Конкурентный доступ к SQLite при высокой нагрузке.
- Memory growth при большом числе активных WS соединений.
- Разрыв соединений и повторные подключения.

## 12. Next Iteration (after MVP)

- Авторизация (Google/OIDC или локальная).
- Persisted user sessions.
- Presence (online/offline), typing indicator.
- Message pagination.
- Room access control (private/public).
