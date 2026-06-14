# VOICE-60 Integration

## Depends on
- `VOICE-40` (WebRTC peer connections, OnTrack)
- `VOICE-50` (RoomPipeline API)

## Goal
Wire webrtc-rs and GStreamer together into a running MCU.
By the end: two browser tabs in the same room hear each other's voice.

## Scope

### Room-level GStreamer state
One `RoomPipeline` per active voice room, stored alongside the `RoomRegistry`:

```rust
static VOICE_GST: LazyLock<Mutex<HashMap<String, RoomPipeline>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
```

Create a `RoomPipeline` on first participant join, drop it when the last participant leaves.

### Inbound loop (OnTrack → appsrc)
Replace the logging stub in `VOICE-40`'s `on_track` with a real read loop:

```rust
pc.on_track(move |track, _, _| {
    let peer_id = peer_id.clone();
    tokio::spawn(async move {
        loop {
            match track.read_rtp().await {
                Ok((pkt, _)) => {
                    let bytes = pkt.marshal().unwrap();
                    VOICE_GST.lock().unwrap()
                        .get(&room_id)
                        .map(|p| p.push_rtp(&peer_id, &bytes));
                }
                Err(_) => break,  // track closed
            }
        }
    });
});
```

### Outbound loop (appsink → RTCRtpSender)
After adding the participant to `RoomPipeline`, start an outbound loop:

```rust
tokio::spawn(async move {
    loop {
        let bytes = {
            VOICE_GST.lock().unwrap()
                .get(&room_id)
                .and_then(|p| p.pull_rtp(&peer_id))
        };
        if let Some(bytes) = bytes {
            let pkt = rtp::packet::Packet::unmarshal(&mut bytes.as_slice()).unwrap();
            sender.send_rtp(&pkt).await.ok();
        } else {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
});
```

Add a `sendonly` transceiver + `RTCRtpSender` to the peer connection before completing
the SDP exchange (update `on_offer` in `VOICE-40`'s `signaling.rs`):

```rust
let sender = pc.add_transceiver_from_kind(
    RTPCodecType::Audio,
    &[RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Sendonly, .. }]
).await.sender();
```

### Teardown (participant disconnect)
In `VoiceWs::stopped()`:
1. Cancel both inbound and outbound tokio tasks (store `JoinHandle`s in `PeerHandle`)
2. Call `VOICE_GST.lock().get_mut(&room_id).remove_participant(&peer_id)`
3. Close `RTCPeerConnection`: `pc.close().await`
4. If room is now empty: remove `RoomPipeline` from `VOICE_GST`

### Error handling
- `track.read_rtp()` error → exit loop silently (normal on disconnect)
- `push_rtp` with a dropped pipeline → log warning, exit loop
- `sender.send_rtp` error → log warning, continue (transient packet loss is acceptable)

## Deliverables
- `server/src/voice/actor/signaling.rs` — `on_offer` updated to add sendonly transceiver
- `server/src/voice/actor/mod.rs` — inbound/outbound loops started in `on_track`, teardown in `stopped()`
- `server/src/voice/mod.rs` — `VOICE_GST` global registry

## Tests
- Manual end-to-end: two browser tabs in the same room → both hear each other's mic
- Manual: third tab joins mid-call → all three apply mix-minus correctly
- Manual: one tab closes → remaining two still hear each other (no crash, no silence)

## Acceptance
- Two participants in the same room can hear each other (audio flows both ways)
- Participant leaving does not crash the server or silence remaining participants
- Server memory does not grow unboundedly after repeated join/leave cycles
  (check with `top` — `RoomPipeline` is dropped when room empties)
