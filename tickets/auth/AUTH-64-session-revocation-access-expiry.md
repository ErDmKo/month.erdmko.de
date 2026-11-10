---
title: "Client-Initiated Heartbeat Ping, Live Access Revocation & Server-Side Close"
ticket: "AUTH-64"
status: "completed"
draft: false
weight: 64
---

# AUTH-64 Client-Initiated Heartbeat Ping, Live Access Revocation & Server-Side Close

**Priority: P0. Part of [AUTH-60](AUTH-60-authorized-room-broadcasts.md).**

## Depends on

- [AUTH-61](AUTH-61-ws-upgrade-token-admission.md)
- [AUTH-62](AUTH-62-room-registry-join-membership.md)
- [AUTH-63](AUTH-63-direct-action-token-guards.md)

## Goal

Require the client to actively send heartbeat `Ping` frames to keep the WebSocket alive, and close the WebSocket connection from the server side whenever **either** client pings stop arriving (`CLIENT_TIMEOUT`) **or** the client's `session_token` / paid access (`access_until`) is revoked or expired.

## Problem

1. **Server-sent `ctx.ping(b"")` keeps passive/zombie sockets alive automatically**:
   `ChatWs::start_heartbeat` in `server/src/pages/chat/chat_actor.rs` currently sends a protocol-level `ctx.ping(b"")` every 5 seconds, and the browser/OS WebSocket stack automatically replies with `ws::Message::Pong` (updating `self.hb`) without the client application (`assets/js/chat/`) ever proving it is an active chat client. An unjoined raw WebSocket client or a hung browser tab stays alive indefinitely because the server pings it and accepts the OS-level auto-`Pong`.
2. **Connections stay open after session revocation or paid-access expiry**:
   If a user's session is revoked (`POST /auth/logout`), expires, or `wallet_profiles.access_until` passes while the WebSocket is open, the server neither closes the connection on the heartbeat check nor blocks passive broadcast delivery.

## Scope

- **Replace legacy WS Ping/Pong with `ClientPing` (`contracts/chat/chat.proto`, `server/src/chat/service.rs`, `assets/js/chat/`)**:
  - Add `ClientPing` (`ping = 12`) to `ClientFrame` in `contracts/chat/chat.proto`.
  - Remove `ctx.ping(b"")`, `ws::Message::Ping`, `ws::Message::Pong`, and unconditional `ws::Message::Binary` heartbeat updates from `ChatWs` (`server/src/pages/chat/chat_actor.rs`) — no backward compatibility with legacy WS control-frame ping/pong.
  - Update `self.hb = Instant::now()` **only** in `ChatWs::on_ping` when the client sends `ClientEvent::Ping` and `self.verify_active_token` succeeds.
  - In `assets/js/chat/chat-ui/init.ts`, send `CLIENT_FRAME_PING` periodically (`5s` interval) while the WebSocket is open, and clear the interval on close.
- **Server-side connection close on no-ping OR no-paid/no-session (`server/src/pages/chat/chat_actor.rs`)**:
  - On each `HEARTBEAT_INTERVAL` (`5s`) tick, on incoming client frames (`verify_active_token`), and before delivering room broadcasts (`PushEvent`):
    1. **No client ping within `CLIENT_TIMEOUT` (`10s`)**: close the WebSocket (`ws::CloseCode::Policy`, `"HEARTBEAT_TIMEOUT"`), remove from `CHAT_ROOMS`, and stop the actor.
    2. **Session revoked/expired (`UNAUTHORIZED`) or paid access expired (`PAYMENT_REQUIRED`)**: remove from `CHAT_ROOMS`, leave voice (`self.do_voice_leave()`), send `ServerError` (`UNAUTHORIZED` or `PAYMENT_REQUIRED`), close the WebSocket (`ws::CloseCode::Policy`), and stop the actor.
- **Client handling (`assets/js/chat/chat-ui/init.ts`)**:
  - When the WebSocket receives `UNAUTHORIZED` or `PAYMENT_REQUIRED` (or closes with policy violation `1008`), clear the ping interval and redirect to `/chat?room={slug}` onboarding (or display an actionable error banner).

## Implementation Areas

- `contracts/chat/chat.proto`
- `server/src/chat/service.rs`
- `server/src/pages/chat/chat_actor.rs` and `server/src/pages/chat/dispatch.rs`
- `server/src/pages/chat/tests/`
- `assets/js/chat/chat-ui/init.ts` and `assets/js/chat/protocol/outgoing.ts`

## Tests and Acceptance

- [x] Legacy WS `Ping`/`Pong` frames are ignored for heartbeat; a WebSocket connection that does not send `ClientPing` within `CLIENT_TIMEOUT` is closed by the server.
- [x] Sending `ClientPing` refreshes `self.hb` when the session token and paid access are valid, and closes the connection if session/paid access is lost.
- [x] Revoking a session (`revoke_session` / `POST /auth/logout`) or expiring `wallet_profiles.access_until` while a WebSocket is joined removes the client from broadcast recipients, leaves voice if active, sends `UNAUTHORIZED` or `PAYMENT_REQUIRED`, and closes the socket from the server side.
- [x] Subsequent room broadcasts after revocation/expiry are never delivered to the revoked/expired client.
- [x] Browser client sends periodic `CLIENT_FRAME_PING` while connected and redirects to `/chat?room={slug}` onboarding when `UNAUTHORIZED` or `PAYMENT_REQUIRED` is received.

## Result

**Status: DONE**

### Implemented modules
- `contracts/chat/chat.proto`, `server/src/generated/chat.rs`, `server/src/generated/chat.descriptor.json` — added `ClientPing` (`ping = 12`) to `ClientFrame`.
- `server/src/chat/service.rs` & `server/src/pages/chat/dispatch.rs` — parsed and dispatched `ClientEvent::Ping` to `ChatWs::on_ping`.
- `server/src/pages/chat/chat_actor.rs` — removed legacy `ctx.ping(b"")`, `ws::Message::Ping`, `ws::Message::Pong`, and passive `ws::Message::Binary` heartbeat updates; added `BroadcastEvent` token validation and `close_for_revoked_access` so the server closes the connection on either missing `ClientPing` (`HEARTBEAT_TIMEOUT`) or lost session/paid access (`UNAUTHORIZED` / `PAYMENT_REQUIRED`).
- `assets/js/chat/chat-ui/init.ts` & `assets/js/chat/chat-ui/chat-ui.test.ts` — sends periodic `CLIENT_FRAME_PING` while open and redirects to `/chat?room={slug}` onboarding when `UNAUTHORIZED` or `PAYMENT_REQUIRED` is received.
- `server/src/pages/chat/tests/messaging.rs` & `attachments.rs` — verified `ClientPing`, immediate broadcast blocking, `UNAUTHORIZED` / `PAYMENT_REQUIRED` delivery, and server-initiated WebSocket close on session revocation or paid-access expiry.
