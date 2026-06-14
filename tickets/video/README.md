# Voice Calling Tickets (Audio-Only MCU)

## Execution Order

1. `VOICE-10` Dependencies
2. `VOICE-20` Signaling Server
3. `VOICE-30` VPS & Network
4. `VOICE-40` WebRTC Connection
5. `VOICE-50` GStreamer Audio Engine
6. `VOICE-60` Integration
7. `VOICE-70` Browser Client

## Dependency Map

- `VOICE-10` → none
- `VOICE-20` → `VOICE-10`
- `VOICE-30` → `VOICE-10`
- `VOICE-40` → `VOICE-20`, `VOICE-30`
- `VOICE-50` → `VOICE-10`
- `VOICE-60` → `VOICE-40`, `VOICE-50`
- `VOICE-70` → `VOICE-20`, `VOICE-60`

## Ticket Files

- `VOICE-10-dependencies.md`
- `VOICE-20-signaling.md`
- `VOICE-30-vps-network.md`
- `VOICE-40-webrtc-connection.md`
- `VOICE-50-gstreamer-engine.md`
- `VOICE-60-integration.md`
- `VOICE-70-browser-client.md`

## Epics

### Epic 1: Base Infrastructure
`VOICE-10`, `VOICE-20`, `VOICE-30`

Extend the existing Actix-Web server with WebRTC dependencies and voice signaling messages.
No new endpoint — voice signaling runs over the existing `/ws/chat/{room_id}` connection.
New protobuf messages are added to `chat.proto`; voice state lives inside the existing `ChatWs` actor.

### Epic 2: WebRTC Connection
`VOICE-40`

Establish a working WebRTC peer connection per participant and receive their audio track.
No mixing yet — confirm RTP packets arrive and log codec info.

### Epic 3: GStreamer Audio Engine
`VOICE-50`

Per-participant decode pipeline (`appsrc → rtpopusdepay ! opusdec ! audioconvert ! audioresample`),
mix-minus audiomixer (N mixers for N participants), and per-participant encode pipeline
(`audiomixer ! opusenc ! rtpopuspay ! appsink`).

### Epic 4: Integration
`VOICE-60`

Wire webrtc-rs and GStreamer together: inbound RTP → appsrc, appsink → outbound RTP.
Includes teardown logic for disconnecting participants.

### Epic 5: Browser Client
`VOICE-70`

Voice controls embedded inside the existing chat room UI — no new page or route.
"Join voice" button, mute toggle, participant list, and a hidden `<audio>` element for the mixed stream.
Uses the existing chat WebSocket connection for all signaling.

## Key Design Decisions

- **No new endpoint**: signaling runs on the existing `/ws/chat/{room_id}` WS connection.
- **No new actor**: voice state (`VoiceSessionState`) lives inside the existing `ChatWs` actor.
- **Proto extension**: 4 new `ClientFrame` fields (8–11) and 4 new `ServerFrame` fields (11–14) added to `chat.proto`.
- **Signaling format**: binary protobuf, same as all other chat frames — no JSON text frames.
- **MCU model**: every browser connects to the server via WebRTC. Server owns all peer connections and does all mixing. No peer-to-peer signaling relay.
- **Audio codec**: Opus end-to-end (browser → server → browser). No transcoding.
- **Mix-minus**: N `audiomixer` instances for N participants to prevent echo.
- **NAT**: `NAT1To1IPs` hardcoded to VPS public IP — no external STUN dependency.
- **Identity**: voice participants reuse `sender_id` / `sender_name` from the chat join — no new identity.
- **Video**: explicitly out of scope for this phase.

## Deferred (Post-Voice)

- Video tracks, compositor, x264enc
- Recording / playback
- Screen share
- Noise suppression (`webrtcdsp` GStreamer element)
- Scalable codecs (SVC, simulcast)
