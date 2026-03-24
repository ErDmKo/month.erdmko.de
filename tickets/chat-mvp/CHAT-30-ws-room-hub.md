# CHAT-30 WebSocket Room Hub

## Depends on
- `CHAT-20`

## Goal
Сделать realtime-обмен сообщениями между 2+ клиентами в комнате.

## Scope
- In-memory room registry: `room_id -> connections`.
- Обработать `join`: join room + отправка `history`.
- Обработать `message`: validate + persist + broadcast.
- Cleanup на disconnect.

## Deliverables
- Рабочий WS handler для `/ws/chat/{room_id}`.
- Broadcast только после успешного сохранения сообщения.

## Tests
- Integration test: два WS-клиента в одной комнате получают broadcast.
- Isolation test: клиент из другой комнаты не получает сообщение.
- Join test: после `join` клиент получает `history`.
- Negative test: невалидный payload -> `error` только отправителю.
- Disconnect test: после disconnect соединение удаляется из room registry.

## Acceptance
- 2 клиента в одной комнате видят сообщения друг друга в realtime.
- Ошибки валидации отправляются только инициатору.
