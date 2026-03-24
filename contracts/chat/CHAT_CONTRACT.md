# Chat Contract (MVP)

## Scope

- Room is defined by websocket URL: `/ws/chat/{room_id}`.
- Text-only messages.
- Message length limit: `1..200` chars.

## HTTP

`GET /chat/{room_id}`
- Response: `200 text/html`

`GET /ws/chat/{room_id}`
- Response: WebSocket upgrade `101`

## Envelope

All WS payloads are JSON with:
- `type`: string
- `requestId`: string (optional)
- `ts`: ISO8601 string (server events)

## Client -> Server

`join`
```json
{
  "type": "join",
  "requestId": "req-1",
  "nickname": "dima"
}
```

Rules:
- `nickname`: required, `1..32` chars after trim

`message`
```json
{
  "type": "message",
  "requestId": "req-2",
  "body": "hello team"
}
```

Rules:
- `body`: required, `1..200` chars after trim

## Server -> Client

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

## Error Codes

- `VALIDATION_ERROR`
- `BAD_PAYLOAD`
- `UNSUPPORTED_EVENT_TYPE`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

## Delivery Rules

- Message order is server-defined by `id` and `createdAt`.
- Broadcast happens only after successful DB persist.
- Delivery semantic for MVP: at-most-once.
- On reconnect client sends `join` and receives `history`.

## Limits

- `nickname <= 32`
- `body <= 200`
- inbound WS payload <= `4KB`
- history default: last `50` messages

## Security

- Server validates all inputs.
- Invalid command -> `error` only to sender.
- Message content is plain text.
- Client rendering must use safe text output (`textContent`).
