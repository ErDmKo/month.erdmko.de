---
title: "Voice Signaling Server"
ticket: "VOICE-20"
status: "completed"
draft: false
weight: 20
---

# VOICE-20 Signaling Server

## Depends on
- `VOICE-10`

## Goal
Extend the existing chat WebSocket protocol with voice signaling messages.
Voice calls happen **inside a chat room** — no new endpoint, no new actor.
The existing `/ws/chat/{room_id}` connection carries both chat and voice frames.
Signaling is strictly browser↔server (MCU model — server is the only WebRTC peer).

## Scope

### Proto extension — `contracts/chat/chat.proto`

Extend `ClientFrame` and `ServerFrame` with new voice fields.
Use field numbers 8+ (client) and 11+ (server) to avoid conflicts with existing fields.

```protobuf
message ClientFrame {
  oneof payload {
    // ... existing fields 1–7 unchanged ...
    ClientVoiceJoin  voice_join  = 8;
    ClientVoiceLeave voice_leave = 9;
    ClientVoiceOffer voice_offer = 10;
    ClientVoiceIce   voice_ice   = 11;
  }
}

message ServerFrame {
  oneof payload {
    // ... existing fields 1–10 unchanged ...
    ServerVoiceState  voice_state  = 11;
    ServerVoiceAnswer voice_answer = 12;
    ServerVoiceIce    voice_ice    = 13;
    ServerVoiceError  voice_error  = 14;
  }
}
```

### New message definitions

```protobuf
// Client → Server: request to join the voice call in the current room
message ClientVoiceJoin {
  string request_id = 1;
}

// Client → Server: leave the voice call (keep chat connection open)
message ClientVoiceLeave {
  string request_id = 1;
}

// Client → Server: SDP Offer to establish WebRTC connection with the server
message ClientVoiceOffer {
  string request_id = 1;
  string sdp        = 2;
}

// Client → Server: trickle ICE candidate
message ClientVoiceIce {
  string request_id    = 1;
  string candidate     = 2;
  string sdp_mid       = 3;
  uint32 sdp_mline_idx = 4;
}

// Server → Client: current voice participants in the room (broadcast on join/leave)
message ServerVoiceState {
  repeated VoiceParticipant participants = 1;
}

message VoiceParticipant {
  string sender_id   = 1;  // reuse the chat sender_id — no new identity needed
  string sender_name = 2;
}

// Server → Client: SDP Answer from the server's RTCPeerConnection
message ServerVoiceAnswer {
  string request_id = 1;
  string sdp        = 2;
}

// Server → Client: trickle ICE candidate from the server
message ServerVoiceIce {
  string candidate     = 1;
  string sdp_mid       = 2;
  uint32 sdp_mline_idx = 3;
}

// Server → Client: voice-specific error
message ServerVoiceError {
  string request_id = 1;
  string code       = 2;
}
```

### Error codes

| Code | Condition |
|---|---|
| `VOICE_NOT_JOINED` | `voice_offer` or `voice_ice` received before `voice_join` |
| `VOICE_ALREADY_JOINED` | `voice_join` received when already in voice call |
| `VOICE_ROOM_FULL` | Room already has `MAX_VOICE_PARTICIPANTS_PER_ROOM = 8` active |
| `VOICE_NO_NICKNAME` | `voice_join` before `ClientJoin` (chat join must happen first) |

### Server-side voice state in `ChatWs`

Add optional voice state to `ChatSessionState` in `server/src/chat/service.rs`:

```rust
pub struct ChatSessionState {
    pub nickname: Option<String>,
    pub last_messages: VecDeque<Instant>,
    pub voice: Option<VoiceSessionState>,  // None = not in voice call
}

pub struct VoiceSessionState {
    pub peer_connection: Arc<RTCPeerConnection>,
    // inbound/outbound task handles added in VOICE-60
}
```

### Dispatch in `actor/dispatch.rs`

Add arms to the existing `on_binary` match:

```rust
ClientFrame::VoiceJoin(msg)  => self.on_voice_join(msg, ctx),
ClientFrame::VoiceLeave(msg) => self.on_voice_leave(msg, ctx),
ClientFrame::VoiceOffer(msg) => self.on_voice_offer(msg, ctx),
ClientFrame::VoiceIce(msg)   => self.on_voice_ice(msg, ctx),
```

### New handler file `actor/voice.rs`

```
on_voice_join:
  - check nickname is set (else ServerVoiceError VOICE_NO_NICKNAME)
  - check not already in voice (else ServerVoiceError VOICE_ALREADY_JOINED)
  - check room voice count < MAX_VOICE_PARTICIPANTS_PER_ROOM (else VOICE_ROOM_FULL)
  - set session.voice = Some(VoiceSessionState { ... stub ... })
  - broadcast ServerVoiceState (updated participant list) to room

on_voice_leave:
  - if session.voice is None: no-op
  - drop VoiceSessionState (peer connection teardown handled in VOICE-60)
  - set session.voice = None
  - broadcast ServerVoiceState to room

on_voice_offer:
  - if session.voice is None: ServerVoiceError VOICE_NOT_JOINED
  - stub: log SDP, send back placeholder ServerVoiceAnswer (real logic in VOICE-40)

on_voice_ice:
  - if session.voice is None: ServerVoiceError VOICE_NOT_JOINED
  - stub: log candidate (real logic in VOICE-40)
```

`on_voice_join` and `on_voice_leave` also fire on `ChatWs::stopped()` —
if the client disconnects mid-call, treat it as an implicit `voice_leave`.

### Voice participant count helper

Add to `RoomRegistry` (or as a free function using it):

```rust
pub fn voice_participant_count(&self, room_id: &str) -> usize
```

Counts actors in the room where `session.voice.is_some()`.
Used for `VOICE_ROOM_FULL` enforcement.

## Deliverables
- `contracts/chat/chat.proto` — extended with 8 new message types + 2 frame fields each
- `server/src/chat/service.rs` — `VoiceSessionState` added to `ChatSessionState`
- `server/src/pages/chat/actor/dispatch.rs` — 4 new arms
- `server/src/pages/chat/actor/voice.rs` — stub handlers
- Codegen: `server/build.rs` picks up new messages automatically (no changes needed)
- TS codegen: `assets/js/gen/chat.ts` regenerated to include new types

## Tests
- Unit: `voice_join` before chat join → `VOICE_NO_NICKNAME`
- Unit: `voice_join` twice → `VOICE_ALREADY_JOINED`
- Unit: 9th `voice_join` in a room with 8 active → `VOICE_ROOM_FULL`
- Unit: `voice_offer` before `voice_join` → `VOICE_NOT_JOINED`
- Unit: disconnect mid-call → `ServerVoiceState` broadcast with participant removed
- Unit: `ServerVoiceState` contains correct nicknames after join/leave sequence

## Acceptance
- Sending `ClientVoiceJoin` over the chat WS receives `ServerVoiceState` with the caller listed
- All existing chat tests still pass (`cargo test -p server`)
- Proto compiles without errors
- New field numbers do not conflict with existing ones
