---
title: "Voice WebRTC Connection"
ticket: "VOICE-40"
status: "completed"
draft: false
weight: 40
---

# VOICE-40 WebRTC Connection

## Depends on
- `VOICE-20` (signaling actor exists)
- `VOICE-30` (PUBLIC_IP and port range in env)

## Goal
Replace the stub signaling handlers with real WebRTC peer connections.
By the end of this ticket: the browser connects, audio negotiation completes,
and incoming Opus RTP packets are logged on the server. No GStreamer yet.

## Scope

### RTCConfiguration
Build once at server startup and share via `Arc`:

```rust
let config = RTCConfiguration {
    ice_servers: vec![],  // no external STUN needed
    ..Default::default()
};

// Tell webrtc-rs to always announce PUBLIC_IP in ICE candidates
let setting_engine = SettingEngine::default();
setting_engine.set_nat_1to1_ips(vec![public_ip], RTCIceCandidateType::Host);
setting_engine.set_ephemeral_udp_port_range(port_min, port_max);
```

### PeerHandle
Each `VoiceWs` actor owns a `PeerHandle` — a struct holding:
```rust
struct PeerHandle {
    peer_connection: Arc<RTCPeerConnection>,
    peer_id: String,
}
```

Spawn the `RTCPeerConnection` in `signaling::on_offer()`.

### SDP Offer/Answer flow
In `actor/signaling.rs`:

```
on_offer(sdp):
  1. pc.set_remote_description(RTCSessionDescription::offer(sdp)).await
  2. answer = pc.create_answer(None).await
  3. pc.set_local_description(answer).await
  4. send {"type":"answer","sdp": answer.sdp} back over WS
```

### ICE trickle
```
on_ice(candidate, sdp_mid, sdp_mline_index):
  pc.add_ice_candidate(RTCIceCandidateInit { candidate, sdp_mid, sdp_mline_index }).await

pc.on_ice_candidate(|candidate| {
    // send {"type":"ice","candidate":...} back over WS signaling channel
})
```

### OnTrack — confirm audio arrives
```rust
pc.on_track(|track, _, _| {
    log::info!(
        "[voice] track received: kind={}, codec={}, ssrc={}, peer={}",
        track.kind(),
        track.codec().capability.mime_type,
        track.ssrc(),
        peer_id,
    );
    // RTP reading loop will be added in VOICE-60
});
```

### Audio-only transceiver
Add a `recvonly` transceiver before creating the answer so the SDP correctly advertises
audio receive capability and the browser knows to send audio:

```rust
pc.add_transceiver_from_kind(
    RTPCodecType::Audio,
    &[RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Recvonly, ..Default::default() }]
).await;
```

A `sendonly` transceiver for outbound mix will be added in `VOICE-60`.

## Deliverables
- `server/src/voice/actor/signaling.rs` — `on_offer()` and `on_ice()` fully implemented
- `server/src/voice/mod.rs` — `RTCConfiguration` and `SettingEngine` built at startup
- `PeerHandle` struct with `peer_connection` and `peer_id`
- `OnTrack` callback logging audio track info

## Tests
- Manual end-to-end: open `VOICE-70` browser client stub (or use `offer.html` test page),
  complete ICE negotiation, observe server log: `[voice] track received: kind=audio, codec=audio/opus`
- Unit: `on_offer` with a valid SDP string does not panic (mock peer connection)

## Acceptance
- Browser and server complete ICE negotiation (no ICE failure in browser DevTools)
- Server log shows `[voice] track received` with codec `audio/opus`
- Disconnecting browser does not panic the server
