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
