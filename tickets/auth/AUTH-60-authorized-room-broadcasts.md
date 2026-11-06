---
title: "Require Authorized Membership for Room Broadcasts"
ticket: "AUTH-60"
status: "planned"
draft: false
weight: 60
---

# AUTH-60 Require Authorized Membership for Room Broadcasts

**Priority: P0. Blocks paid-chat deployment.**

## Depends on

- [AUTH-40](AUTH-40-ws-chat-enforcement.md)

## Goal

Only authenticated users with active paid access and a successful room join can receive room data.

## Confirmed Bug

Reproduced on 2026-11-06 against the `89bf688` application in an isolated local server with synthetic data:

1. Create a paid test profile and valid session in the isolated SQLite database.
2. Open `/ws/chat/readiness-probe` without a cookie, using an allowed Origin. Do not send a join frame.
3. Open a second connection with the paid test session, join the same room, and send a synthetic message.
4. The anonymous connection receives the message broadcast.

Observed: anonymous HTTP room request returned `303`; paid HTTP room request returned `200`;
anonymous WebSocket opened and received the paid message without joining.
The HTTP redirect does not protect the WebSocket stream.

`ChatWs::started` registers every connection in `CHAT_ROOMS`. `PushEvent` and `PushBinary`
forward payloads without checking authorized membership. Join-time checks do not remove
unjoined clients from the broadcast recipients.

## Scope

- Require a valid session and active paid access for chat WebSocket admission.
- Separate connection-limit accounting from authorized room membership.
- Register a broadcast recipient only after successful authenticated room join.
- Apply the recipient rule to messages, deletion events, attachment notifications, and voice signaling.
- Guard direct data requests as well as broadcasts, including history and attachment downloads.
- Revoke membership on disconnect, session revocation/expiry, or paid-access expiry; document and test the enforcement timing.
- Keep origin checks, connection limits, and wallet-based ownership enforcement.

## Implementation Areas

- `server/src/pages/chat/mod.rs`
- `server/src/pages/chat/chat_actor.rs`
- `server/src/chat/service.rs`
- `server/src/chat/messaging_actor.rs`
- `server/src/attachments/` and `server/src/voice/`
- `server/src/pages/chat/tests/`

## Tests and Acceptance

- [ ] The reproduction above cannot deliver any room data to the anonymous client.
- [ ] Missing, invalid, expired, revoked, and unpaid sessions cannot receive room data.
- [ ] Authenticated but unjoined clients cannot receive broadcasts.
- [ ] Two authorized members exchange messages, attachments, and voice signaling normally.
- [ ] Different rooms remain isolated and rejected/disconnected clients release connection slots.
- [ ] Tests cover access revocation and expiry while a WebSocket remains open.
- [ ] Client redirects to onboarding or shows an actionable error when access is lost.
