---
title: "Chat MVP QA and Release"
ticket: "CHAT-70"
status: "pending"
draft: true
weight: 80
---

# CHAT-70 QA & Release

## Depends on
- `CHAT-50`
- `CHAT-60`

## Goal
Проверить MVP end-to-end и подготовить к выкладке.

## Scope
- Smoke test: 2-3 клиента в одной комнате.
- Проверка ограничений: пустое сообщение, 201+ символ.
- Проверка после перезапуска: история сохраняется.
- Проверка входа в чат с главной страницы.
- Обновление README по запуску и использованию.

## Deliverables
- Чеклист пройденных проверок.
- Обновленный README.

## Tests
- E2E smoke: 2-3 клиента обмениваются сообщениями в одной комнате.
- Validation e2e: пустое и >200 сообщение корректно отклоняются.
- Restart test: после рестарта история комнаты сохраняется.
- Entry-point test: переход из главной страницы в чат работает.
- Manual sanity: проверка UX статусов `connecting/online/offline`.

## Acceptance
- Все критерии из `/CHAT_MVP_PLAN.md` выполнены.

## Result

**Status: PENDING**

All acceptance criteria from CHAT-00 through CHAT-60 are met by the implementation. The following items from this ticket's scope remain to be completed:

- [ ] Manual smoke test: 2–3 clients exchanging messages in one room
- [ ] Validation e2e: empty and >200 char messages rejected correctly in the browser
- [ ] Restart test: history persists after server restart (SQLite-backed, expected to pass)
- [ ] Entry-point test: navigation from main page to `/chat/general` works end-to-end
- [ ] Manual UX check: `connecting` / `online` / `offline` status transitions visible in UI
- [ ] QA checklist document created and signed off
- [ ] README updated with run instructions and chat usage
