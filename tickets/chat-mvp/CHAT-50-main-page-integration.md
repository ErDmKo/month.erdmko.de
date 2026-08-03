---
title: "Chat MVP Main Page Integration"
ticket: "CHAT-50"
status: "completed"
draft: false
weight: 60
---

# CHAT-50 Main Page Integration

## Depends on
- `CHAT-40`

## Goal
Интегрировать вход в чат с текущей главной страницы.

## Scope
- Добавить блок/ссылку на `/chat/general` в main page.
- Опционально добавить поле `room_id` и переход на `/chat/{room_id}`.
- Не ломать текущие секции главной страницы.

## Deliverables
- Изменения в `main_page.rs` и `main.html`.

## Acceptance
- С главной страницы есть рабочий entry-point в чат за 1 клик.

## Result

**Status: DONE**

### Link added to main page
`server/src/pages/main_page.rs` — "Open chat" entry in the `tools` list (line 122):
```rust
MainPageLink {
    name: "General chat room",
    href: "/chat/general",
    text: "Open chat",
},
```

The link is rendered by `server/templates/main.html` alongside other tools (Base64, Random, Month, Slugify, Catalog) and takes the user directly to `/chat/general` in one click.
