# VOICE-80 Server Inbound RTP Jitter Buffer

## Depends on
- `VOICE-60` (WebRTC-to-GStreamer RTP bridge)

## Goal
Stabilize each browser's inbound RTP/Opus stream before decoding and
server-side mixing. Network packets can arrive late or in bursts even when
WebRTC is connected; without a server-side jitter buffer those timing changes
are passed directly into the MCU mixer and affect every listener.

The browser already maintains a WebRTC jitter buffer for the server-to-browser
leg. This ticket covers the opposite leg: browser RTP received by webrtc-rs and
then pushed into GStreamer via `ParticipantPipeline::appsrc`.

## Scope

### Add `rtpjitterbuffer` to the inbound participant pipeline
Change the pipeline in `server/src/voice/gst/participant.rs` from:

```
appsrc -> rtpopusdepay -> opusdec -> audioconvert -> audioresample -> tee
```

to:

```
appsrc -> rtpjitterbuffer -> rtpopusdepay -> opusdec -> audioconvert -> audioresample -> tee
```

The jitter buffer must operate on the original RTP packets, before
`rtpopusdepay` strips their sequence numbers and timestamps.

### Initial behavior and tuning
- Start with a bounded latency target appropriate for interactive voice, such
  as 60 ms. Make the value a named constant so it can be measured and tuned.
- Keep packet buffering bounded: a late burst must not create unbounded memory
  use or steadily increase end-to-end latency.
- Enable loss reporting where supported so missing RTP sequence numbers are
  handled as loss rather than causing later audio to wait indefinitely.
- Verify the appsrc timestamp configuration and jitter-buffer mode are
  compatible with RTP timestamps from `track.read_rtp()`; do not synthesize or
  rewrite RTP sequence numbers or timestamps in the Rust bridge.
- Preserve the existing Opus payload type and 48 kHz RTP caps.

### Observability
- Log jitter-buffer setup once per participant, including peer ID and selected
  latency.
- Add rate-limited diagnostics for detected packet loss, late drops, or
  discontinuities. Do not log every RTP packet.
- Record the chosen latency and observed loss/drop counters in a form suitable
  for later metrics integration.

### Teardown and dynamic rooms
- The jitter-buffer element is part of `ParticipantPipeline` and must follow
  the existing EOS, `Null`, and pipeline-removal lifecycle.
- Join and leave behavior must remain safe while another participant is
  speaking; no stale queued RTP may be routed after the participant has been
  removed.
- Do not alter the existing directed mix-minus topology.

## Non-goals
- Replacing WebRTC with a custom WebSocket audio relay.
- Changing browser-side WebRTC jitter-buffer behavior.
- Adding client-side audio processing, recording, video, or noise suppression.
- Re-encoding or changing the Opus codec configuration beyond the existing
  decode/mix/encode flow.

## Deliverables
- `server/src/voice/gst/participant.rs` -- inbound RTP jitter-buffer element
  and configuration.
- `server/src/voice/gst/mod.rs` or `participant.rs` -- bounded diagnostics and
  test helpers, if needed.
- Tests demonstrating that the pipeline remains live with reordered and
  missing input RTP packets.

## Tests
- Unit: create a two-participant `RoomPipeline`, send a real increasing RTP
  sequence from A, and confirm B receives mixed output as today.
- Unit: swap two adjacent RTP packets before pushing them into A; B still
  receives playable output and the pipeline does not stall.
- Unit: omit an RTP packet from a valid sequence; subsequent packets continue
  through the pipeline after the jitter-buffer latency expires.
- Unit: remove A while buffered packets are pending; the room remains in
  `Playing` state and B's pipeline does not crash or deadlock.
- Manual: introduce packet delay/jitter on a browser client network path and
  confirm remote speech remains paced without repeated gaps or bursty audio.

## Acceptance
- Inbound RTP is reordered and paced before Opus decoding and `audiomixer`.
- Late or missing RTP does not permanently stall a participant's audio branch.
- The added buffering has a documented, bounded latency budget suitable for
  interactive voice.
- Existing two- and three-participant mix-minus flows still work.
- Repeated join/leave cycles do not leak jitter-buffer elements or increase
  room latency over time.
