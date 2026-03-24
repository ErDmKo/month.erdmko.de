# Bazel Test Runbook (Chat MVP)

Цель: выполнять все проверки через Bazel как основной путь.

## 1. Global Commands

- Full build: `bazel build //...`
- Full tests: `bazel test //...`
- Run server: `bazel run //server:server`

## 2. Ticket-by-Ticket Commands

## CHAT-00 Foundation

- Build smoke:
```bash
bazel build //server:server //assets/css //assets/js:month-bundle
```
- Runtime smoke:
```bash
bazel run //server:server
# then open /chat/general
```

## CHAT-10 API Contract Freeze

- Contract fixture tests (target to add in this ticket):
```bash
bazel test //server/tests:chat_contract_test
```

## CHAT-20 Data Layer

- DB unit/integration tests (targets to add):
```bash
bazel test //server/tests:chat_db_test
```

## CHAT-30 WebSocket Room Hub

- WS integration tests (target to add):
```bash
bazel test //server/tests:chat_ws_room_test
```

## CHAT-40 Chat Page UI

- Frontend unit tests (target to add):
```bash
bazel test //assets/js/chat:chat_ui_test
```
- Static build check:
```bash
bazel build //assets/js:month-bundle //assets/css
```

## CHAT-60 Stability & Security

- Limits/rate/security tests (target to add):
```bash
bazel test //server/tests:chat_stability_security_test
```

## CHAT-70 QA & Release

- Full gate before release:
```bash
bazel test //...
bazel build //...
```
- Manual smoke after server run:
```bash
bazel run //server:server
```

## 3. Target Naming Convention

Чтобы не было хаоса, используем единый нейминг:

- Backend tests: `//server/tests:<feature>_test`
- Frontend tests: `//assets/js/chat:<feature>_test`
- Smoke/integration tests: `//server/tests:chat_<scope>_test`

## 4. CI Gate (Recommended)

Минимальный gate для PR:

```bash
bazel test //server/tests:chat_contract_test \
  //server/tests:chat_db_test \
  //server/tests:chat_ws_room_test
```

Расширенный gate перед merge в `master`:

```bash
bazel test //...
```
