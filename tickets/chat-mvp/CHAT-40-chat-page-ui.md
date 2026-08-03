---
title: "Chat MVP Chat Page UI"
ticket: "CHAT-40"
status: "completed"
draft: false
weight: 50
---

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

## Result

**Status: DONE**

### HTML template
`server/templates/chat.html` — extends `inner.html`, renders `<div class="js-chat" data-room-id="{{ room_id }}">` as mount point. Loads `chat-bundle.js` asynchronously.

### UI structure
`assets/js/chat/template.ts` — `chatUiTemplate()` (line 39) builds the full DOM via the VDOM helper:
- Status indicator (`CHAT_REF_STATUS`) and error area (`CHAT_REF_ERROR`, `aria-live="polite"`)
- Welcome screen (`CHAT_REF_WELCOME`) with join form: nickname input + Join button
- Chat screen (`CHAT_REF_CHAT_SCREEN`, initially hidden) with message list (`CHAT_REF_MESSAGES`, `aria-live="polite"`), textarea composer, character counter, and Send button
- Message item template: `chatMessageTemplate()` (line 95) renders sender, timestamp, body via `genText` (safe, no innerHTML), own-message CSS modifier, and delete button with `data-delete-id`

### WS client & state machine
`assets/js/chat/index.ts` — `initTemplate()` (line 96):
- WS URL constructed by `toWsUrl()` (line 71) — uses `wss:` on HTTPS, `ws:` on HTTP
- States: `connecting` (initial) → `online` (ws.onopen) → `offline` (ws.onclose); error text set separately
- `ws.onmessage` (line 209): dispatches `history`, `message`, `deleted`, `error`, `joined` events
- `history`: clears list via `cleanHtml()`, re-renders all items
- `message`: appends new item + autoscrolls (`list.scrollTop = list.scrollHeight`, line 93)
- `deleted`: removes `[data-message-id="N"]` element from DOM (line 232)

### UX controls
`assets/js/chat/index.ts`:
- `Enter` submits message form, `Shift+Enter` does not (keydown handler line 268)
- Send button disabled when body empty or >200 chars (`updateControls()` line 129)
- Join button disabled until online + valid nickname
- Character counter updated on every input (line 134)
- Nickname persisted to `localStorage` per room (`nicknameKey = chat-nickname-{roomId}`, line 100)

### Entry point
`assets/js/chat-effect.ts` — `initChatEffect(window)` called on `window load`, queries all `.js-chat` elements and initialises each (line 1–5).
