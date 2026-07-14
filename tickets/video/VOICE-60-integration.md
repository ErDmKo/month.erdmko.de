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

## Follow-up cleanup: safe dynamic branch removal in `mixer::unlink`

**Not required for this ticket's acceptance criteria, but worth doing here**
since VOICE-60 is the first place `remove_participant` gets exercised with
*real, continuously-flowing* audio (VOICE-50's tests remove a participant
with little or no data in flight — a fast, low-risk case that doesn't
exercise this).

`mixer::unlink` (`server/src/voice/gst/mixer.rs`) currently unlinks a
participant's mix-minus pads directly:

```rust
pub fn unlink(link: &MixLink, pipeline: &gstreamer::Pipeline, tee: &Element, mixer: &Element) {
    let _ = link.tee_pad.unlink(&queue_sink);
    let _ = queue_src.unlink(&link.mixer_pad);
    tee.release_request_pad(&link.tee_pad);
    mixer.release_request_pad(&link.mixer_pad);
    let _ = link.queue.set_state(gstreamer::State::Null);
    let _ = pipeline.remove(&link.queue);
}
```

There's no synchronization guaranteeing a buffer isn't mid-flight through
that `tee → queue → mixer` branch at the exact moment this runs — with
someone actively talking when they disconnect (the realistic VOICE-60
scenario), that's a real race, not just a theoretical one.

GStreamer's own "Dynamic Pipelines" pattern for safely removing a live
branch (see the application-development manual,
[Pipeline manipulation](https://gstreamer.freedesktop.org/documentation/application-development/advanced/pipeline-manipulation.html#changing-elements-in-a-pipeline)):

1. Install a **blocking pad probe** (`PAD_PROBE_TYPE_BLOCK`) on the pad
   feeding the branch (e.g. the `queue`'s sink pad, or `tee_pad` itself) —
   this pauses new dataflow into the branch from that point on.
2. Send an **EOS event** into just that branch (not the whole pipeline) so
   anything already queued drains out cleanly.
3. Wait for the EOS to actually reach the far end (e.g. via an event probe,
   or the mixer's pad receiving EOS) before proceeding.
4. Only then unlink the pads, `release_request_pad`, and tear down the
   `queue` — as `unlink` does today.

Implement this as the removal path once `remove_participant` is exercised
under real load in this ticket's manual tests — if disconnecting a talking
participant ever produces a GStreamer flow error, a stuck pipeline, or a
crash in practice, this is the fix.
