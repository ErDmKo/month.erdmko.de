# Chat MVP Tickets

Источник: `/CHAT_MVP_PLAN.md`

## Execution Order

1. `CHAT-00` Foundation
2. `CHAT-10` API Contract Freeze
3. `CHAT-20` Data Layer
4. `CHAT-30` WebSocket Room Hub
5. `CHAT-40` Chat Page UI
6. `CHAT-50` Home Page Integration
7. `CHAT-60` Stability & Security
8. `CHAT-70` QA & Release

## Dependency Map

- `CHAT-00` -> none
- `CHAT-10` -> `CHAT-00`
- `CHAT-20` -> `CHAT-10`
- `CHAT-30` -> `CHAT-20`
- `CHAT-40` -> `CHAT-10`, `CHAT-30`
- `CHAT-50` -> `CHAT-40`
- `CHAT-60` -> `CHAT-30`, `CHAT-40`
- `CHAT-70` -> `CHAT-50`, `CHAT-60`

## Ticket Files

- `CHAT-00-foundation.md`
- `CHAT-10-contract-freeze.md`
- `CHAT-20-data-layer.md`
- `CHAT-30-ws-room-hub.md`
- `CHAT-40-chat-page-ui.md`
- `CHAT-50-main-page-integration.md`
- `CHAT-60-stability-security.md`
- `CHAT-70-qa-release.md`

## Bazel-First Execution

- Базовый запуск проверок: `bazel test //...`
- Базовая сборка: `bazel build //...`
- Запуск сервера: `bazel run //server:server`
- Детальный пошаговый runbook: `BAZEL_TEST_RUNBOOK.md`
