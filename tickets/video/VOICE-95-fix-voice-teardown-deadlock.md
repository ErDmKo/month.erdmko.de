---
title: "Fix Voice Teardown Deadlock and Worker Stall"
ticket: "VOICE-95"
status: "completed"
draft: false
weight: 95
---

# VOICE-95 Fix Voice Teardown Deadlock and Worker Stall

## Depends on
- `VOICE-60` (Voice integration & MCU teardown)
- `VOICE-90` (Live environment deployment)

## Bug Description
The live server running in Docker becomes unresponsive and is restarted by `autoheal` following voice leave or participant disconnect events. Autoheal logs show:
```
Container /my_app found to be unhealthy - Restarting container now with 10s timeout
```

Server logs correlate the freeze immediately after `event=voice_leave`:
```
[INFO server::voice::voice_actor] event=voice_leave room_id=general sender_id=anon-...
```
Following this log entry, the server stops processing all HTTP requests, causing `/healthz` checks to fail and autoheal to restart the container after 90 seconds (3 failed retries).

## Root Cause Analysis
1. **Unbounded GStreamer State Wait:** `ParticipantPipeline::teardown` and `mixer::play_test_tone` call `el.state(gstreamer::ClockTime::NONE)`, which blocks infinitely waiting for elements to transition to `State::Null`. If an element is blocked in a streaming thread or aggregator pad transition, the call never returns.
2. **Synchronous Teardown on Actix Worker:** Actix Web runs with 1 worker thread on single-core host environments. `do_voice_leave()` is invoked synchronously from `ChatWs::stopped()` and `on_voice_leave()`. Calling `crate::voice::leave_room` synchronously executes `mixer::unlink` and `participant.teardown` on the single Actix worker thread.
3. **Probe Drain Timeouts on Inactive Tracks:** `drain_branch` installs a blocking probe and waits for `DRAIN_TIMEOUT` (200ms) plus EOS (200ms). When a participant disconnects abruptly or stops streaming, no buffers trigger the probe, causing a full 400ms synchronous block per link directly on the web worker thread.

## Scope

### 1. Bounded GStreamer State Transitions
- Replace `ClockTime::NONE` with a bounded timeout (e.g., `ClockTime::from_mseconds(50)` or `100ms`) in:
  - `ParticipantPipeline::teardown` in `server/src/voice/gst/participant.rs`
  - `play_test_tone` cleanup thread in `server/src/voice/gst/mixer.rs`

### 2. Async / Non-blocking Teardown
- Offload `crate::voice::leave_room(&room_id, &peer_id)` to a blocking background task (`tokio::task::spawn_blocking`) in `do_voice_leave()` (`server/src/voice/voice_actor.rs`) so it never blocks the Actix event loop or HTTP/healthcheck endpoints.
- Ensure `PeerHandle` drop (aborting RTP loops) remains prompt while pipeline unlinking and element removal proceed safely off-thread.

### 3. Graceful Drain and Unlink
- Ensure `drain_branch` handles idle/closed source pads without unnecessary delays or deadlocks.

## Deliverables
- `server/src/voice/gst/participant.rs` — bounded timeout for `State::Null` transition in `teardown()`.
- `server/src/voice/gst/mixer.rs` — bounded timeout for `play_test_tone` element teardown.
- `server/src/voice/voice_actor.rs` — non-blocking execution of `leave_room` via `spawn_blocking`.
- Regression tests verifying participant join, leave, abrupt disconnect, and teardown under active and idle streams.

## Tests
- Unit/Integration: Test rapid join/leave cycles and confirm no thread or pipeline deadlocks occur.
- Healthcheck during teardown: Verify `/healthz` responds with HTTP 200 while participants leave a voice room.
- End-to-end: Join voice call on deployed instance, disconnect/close browser tab, and confirm container remains healthy.

## Acceptance Criteria
- Participant leave or browser disconnect does not block the Actix Web worker thread.
- GStreamer element teardown uses bounded timeouts and cannot hang indefinitely.
- `/healthz` endpoint continues responding during and after voice call teardowns.
- Container remains healthy and autoheal does not trigger restarts.
