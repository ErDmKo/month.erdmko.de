# CHAT-40 Chat Page UI

## Depends on
- `CHAT-10`
- `CHAT-30`

## Goal
Сделать пользовательский интерфейс комнаты чата.

## Scope
- Шаблон `chat.html`.
- Клиентский скрипт WS.
- Компоненты: header, message list, composer, counter, error area.
- Состояния: `connecting`, `online`, `offline`, `error`.
- UX: Enter send, Shift+Enter newline, autoscroll.

## Deliverables
- Страница `GET /chat/{room_id}` с рабочим UI.
- Безопасный рендер текста через `textContent`.

## Tests
- UI smoke: открытие `/chat/general`, видны основные компоненты.
- WS UI test: при входящем `history` список сообщений рендерится.
- WS UI test: при входящем `message` элемент добавляется в конец.
- Validation test: кнопка send disabled для пустого текста и текста >200.
- UX test: `Enter` отправляет, `Shift+Enter` не отправляет.

## Acceptance
- Пользователь видит history и получает новые сообщения без reload.
- Нельзя отправить пустое сообщение или >200 символов.
