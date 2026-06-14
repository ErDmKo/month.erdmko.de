# VOICE-70 Browser Client

## Depends on
- `VOICE-20` (voice proto messages defined, signaling handlers stubbed)

## Goal
Extend the existing chat UI with voice call functionality inside a chat room.
No new page, no new route. Voice controls appear as part of the existing chat screen.

## Scope

### UI additions to the chat screen

Extend `assets/js/chat/chat-ui/template.ts` with a voice bar below the message form:

```html
<div id="voice-bar">
  <button id="voice-join">Join voice</button>   <!-- hidden when in call -->
  <button id="voice-mute">Mute</button>          <!-- hidden when not in call -->
  <button id="voice-leave">Leave</button>         <!-- hidden when not in call -->
  <span id="voice-status"></span>                 <!-- "Connecting..." / "Connected" / "" -->
  <ul id="voice-participants"></ul>               <!-- list of sender_names in call -->
</div>
<audio id="voice-remote" autoplay></audio>       <!-- hidden, receives mixed audio -->
```

The voice bar is always visible in a joined chat room.
`#voice-mute` and `#voice-leave` are hidden until the local user is in the call.
`#voice-join` is hidden once the user joins.

### TypeScript structure

New module alongside existing chat modules:

```
assets/js/chat/voice/
  index.ts     — init: wire buttons, subscribe to WS voice events
  peer.ts      — RTCPeerConnection lifecycle: createOffer, setAnswer, addIce, ontrack
  ui.ts        — render voice bar state: status text, participant list, button visibility
```

`index.ts` is initialised from the existing `assets/js/chat/index.ts` init pipeline,
receiving the same `ChatSocket` instance — no new WebSocket connection.

### Voice call flow

**Joining:**
```ts
// User clicks "Join voice"
1. stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
   // on denial: show error in #voice-status, abort
2. send ClientVoiceJoin over existing chat WS
3. on ServerVoiceState: update #voice-participants list
4. create RTCPeerConnection({ iceServers: [] })  // no STUN — server uses NAT1To1IPs
5. pc.addTrack(stream.getAudioTracks()[0])
6. offer = await pc.createOffer()
7. pc.setLocalDescription(offer)
8. send ClientVoiceOffer { sdp: offer.sdp }
9. pc.onicecandidate = e => send ClientVoiceIce { ...e.candidate }
```

**On server responses:**
```ts
ServerVoiceAnswer  → pc.setRemoteDescription({ type: 'answer', sdp })
ServerVoiceIce     → pc.addIceCandidate({ candidate, sdpMid, sdpMLineIndex })
ServerVoiceState   → ui.renderParticipants(participants)
ServerVoiceError   → ui.showError(code)
```

**ICE connection state:**
```ts
pc.oniceconnectionstatechange = () => {
  if (pc.iceConnectionState === 'connected')  ui.setStatus('Connected')
  if (pc.iceConnectionState === 'failed')     ui.setStatus('Connection failed')
  if (pc.iceConnectionState === 'disconnected') ui.setStatus('Reconnecting...')
}
```

**Incoming audio:**
```ts
pc.ontrack = e => {
  document.getElementById('voice-remote').srcObject = e.streams[0]
}
```

**Mute toggle:**
```ts
// toggles track.enabled on the local stream — no audio sent, connection stays open
stream.getAudioTracks()[0].enabled = !muted
```

**Leaving:**
```ts
// User clicks "Leave" or chat WS closes
1. send ClientVoiceLeave
2. pc.close()
3. stream.getTracks().forEach(t => t.stop())  // release mic
4. ui.reset()  // hide mute/leave, show join button, clear participants
```

### Integration with existing chat WS event system

The existing `init.ts` uses a `trigger(event, payload)` pattern.
Register voice event handlers the same way chat message handlers are registered:

```ts
// in voice/index.ts
on('voice_state',  payload => ui.renderParticipants(payload.participants))
on('voice_answer', payload => peer.setAnswer(payload.sdp))
on('voice_ice',    payload => peer.addIce(payload))
on('voice_error',  payload => ui.showError(payload.code))
```

Dispatch in `assets/js/chat/protocol/incoming.ts`: add cases for the 4 new `ServerFrame` variants.

### Status display

| Situation | `#voice-status` |
|---|---|
| Not in call | *(empty)* |
| Mic permission pending | `Requesting mic...` |
| Mic denied | `Mic access denied` |
| WS sent, awaiting answer | `Connecting...` |
| ICE connected | `Connected` |
| ICE failed | `Connection failed` |
| ICE disconnected | `Reconnecting...` |

### Participant list

`ServerVoiceState` is broadcast to all room members (not just voice participants).
Everyone in the chat room sees who is currently in the voice call — even if they haven't joined.
Render `sender_name` for each `VoiceParticipant`, highlight the local user.

## Deliverables
- `assets/js/chat/voice/index.ts`, `peer.ts`, `ui.ts`
- `assets/js/chat/chat-ui/template.ts` — voice bar HTML added
- `assets/js/chat/protocol/incoming.ts` — 4 new ServerFrame variants dispatched
- `assets/js/chat/index.ts` — `initVoice` added to init pipeline

## Tests
- Manual: join chat room, click "Join voice", observe `Connected` status and own name in participant list
- Manual: open second tab in same room, both join voice → both hear each other
- Manual: mute → other participant hears silence; unmute → audio resumes
- Manual: click "Leave" → mic released, participant list updated for everyone in room
- Manual: close tab mid-call → other participants' list updates automatically (implicit leave via WS close)
- Existing chat tests unaffected

## Acceptance
- No new page or route needed
- Voice controls appear inside the existing chat room UI after `ClientJoin`
- All voice state changes (join/leave/mute) visible to all room participants in real time
- Mic is released (`track.stop()`) when leaving the call or closing the tab
- No `<video>` elements
- Browser DevTools console is clean (no unhandled promise rejections)
