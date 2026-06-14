# VOICE-50 GStreamer Audio Engine

## Depends on
- `VOICE-10`

## Goal
Build the GStreamer audio MCU pipeline: decode each participant's Opus stream,
apply mix-minus (each person hears everyone except themselves), re-encode for delivery.
This ticket is pure GStreamer — no webrtc-rs wiring yet (that is VOICE-60).

## Scope

### Module structure
```
server/src/voice/
  gst/
    mod.rs        — RoomPipeline: top-level GStreamer state for one voice room
    participant.rs — ParticipantPipeline: per-participant elements (appsrc, decode, appsink, encode)
    mixer.rs      — mix-minus logic: link/unlink pads when participants join/leave
```

### Per-participant inbound pipeline
One `ParticipantPipeline` per connected peer:

```
appsrc  →  rtpopusdepay  !  opusdec  !  audioconvert  !  audioresample  !  [tee]
```

- `appsrc`: name it `src-{peer_id}`, `format=time`, `caps=application/x-rtp,media=audio,encoding-name=OPUS,clock-rate=48000`
- `rtpopusdepay`: strips RTP headers
- `opusdec`: Opus → raw PCM (48kHz, stereo, S16LE)
- `audioconvert` + `audioresample`: normalize to a common format before the mixer
- `tee`: fan-out the decoded PCM to N-1 mixers (all mixers except the participant's own)

### Mix-minus: N mixers for N participants
One `audiomixer` per participant — it receives PCM from all *other* participants.

```
participant_A.tee  ──pad──→  mixer_B
                   ──pad──→  mixer_C

participant_B.tee  ──pad──→  mixer_A
                   ──pad──→  mixer_C

participant_C.tee  ──pad──→  mixer_A
                   ──pad──→  mixer_B
```

When a new participant D joins:
1. Create `ParticipantPipeline` for D (new `appsrc`, decode chain, tee, mixer_D)
2. Link D's `tee` to `mixer_A`, `mixer_B`, `mixer_C`
3. Link `tee_A`, `tee_B`, `tee_C` to `mixer_D`

When participant D leaves:
1. Unlink D's `tee` from all other mixers (request pad release)
2. Unlink all other tees from `mixer_D`
3. Set D's elements to `Null` state and remove from pipeline

Dynamic pad linking must be done while the pipeline is in `Playing` state.
Use `pad.unlink()` then `element.set_state(gst::State::Null)` in the right order.
Send an EOS event into `appsrc` before stopping to drain the pipeline cleanly.

### Per-participant outbound pipeline
After each `audiomixer`:

```
audiomixer  !  opusenc  !  rtpopuspay  !  appsink
```

- `opusenc`: `audio-type=voice`, `bitrate=32000` (suitable for voice on a VPS)
- `rtpopuspay`: wrap PCM → Opus → RTP (default PT 96)
- `appsink`: name it `sink-{peer_id}`, `emit-signals=true`, `sync=false`

### RoomPipeline API (used by VOICE-60)
```rust
impl RoomPipeline {
    pub fn new() -> Self;
    pub fn add_participant(&mut self, peer_id: &str) -> ParticipantPipeline;
    pub fn remove_participant(&mut self, peer_id: &str);
    pub fn push_rtp(&self, peer_id: &str, data: &[u8]);   // push into appsrc
    pub fn pull_rtp(&self, peer_id: &str) -> Option<Vec<u8>>;  // pull from appsink
}
```

## Deliverables
- `server/src/voice/gst/mod.rs` — `RoomPipeline`
- `server/src/voice/gst/participant.rs` — `ParticipantPipeline`
- `server/src/voice/gst/mixer.rs` — pad linking/unlinking helpers

## Tests
- Unit: create a `RoomPipeline`, add 2 participants, push silent RTP into participant A's appsrc,
  confirm appsink for participant B produces buffers (pipeline processes data end-to-end)
- Unit: add then remove a participant — pipeline remains in `Playing` state after removal
- Unit: `push_rtp` with malformed bytes does not panic (appsrc error handling)

## Acceptance
- Two-participant pipeline: PCM pushed into `src-A` appears (after decode → mix → encode) at `sink-B`
- Dynamic join/leave does not crash or deadlock the pipeline
- `cargo test -p server voice::gst` passes
