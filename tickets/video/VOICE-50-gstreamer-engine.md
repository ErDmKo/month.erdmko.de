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
- Two-participant pipeline: PCM pushed into `src-A` appears (after decode → mix → encode) at `sink-B` ✅
- Dynamic join/leave does not crash or deadlock the pipeline ✅
- `cargo test -p server voice::gst` passes ✅ (all 3 tests, none `#[ignore]`d)

## Resolved: `audiomixer` stall on post-`Playing` dynamic pad linking

**Original symptom:** `RoomPipeline::add_participant` requests a new
`audiomixer` sink pad (`request_pad_simple("sink_%u")`) and links it *after*
the room's `Pipeline` is already `Playing` (participants join at arbitrary
times, not all at pipeline creation). Pad probes showed buffers reaching the
source `tee` fine (30/30) but only 1–3 reaching the destination `audiomixer`
sink pad before stalling indefinitely.

This turned out to be **two separate, unrelated bugs**, found by attaching
`lldb` to a genuinely hung test process and reading real thread backtraces
(log-based `GST_DEBUG` tracing alone couldn't distinguish "waiting on a
condvar" from "deadlocked on a mutex" — a live debugger could).

### Bug 1 — `audiomixer` self-deadlock via `start-time-selection=now`

A GStreamer Discourse thread describing a similar-looking symptom
(https://discourse.gstreamer.org/t/bug-in-audiomixer-element-or-just-strange-behaviour/4958)
was answered by a GStreamer maintainer recommending
`start-time-selection=now`, a mode added in
[`aggregator: implement start-time-selection=now` (!9394)](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/merge_requests/9394)
specifically for late-linked live sources. Trying it changed the failure from
"3 buffers then stall" to "1 buffer then stall" — worse, and still broken.

Attaching `lldb` to the hung process and pulling `thread backtrace all`
showed the mixer's src-pad task thread genuinely deadlocked (not waiting on
a signal) inside `gst_element_get_base_time`'s `g_mutex_lock`. Reading
`gstreamer/subprojects/gstreamer/libs/gst/base/gstaggregator.c` confirmed why:

```c
// gst_aggregator_pad_chain_internal():
GST_OBJECT_LOCK (self);                 // locked here, self = the audiomixer
...
case GST_AGGREGATOR_START_TIME_SELECTION_NOW:
  start_time = gst_element_get_current_running_time (GST_ELEMENT (self));
  break;

// gst_element_get_current_running_time() -> gst_element_get_base_time():
GST_OBJECT_LOCK (element);              // same `self`, same non-recursive lock — deadlock
```

`start-time-selection=now` makes `gst_aggregator_pad_chain_internal` call
`gst_element_get_current_running_time(self)` while it already holds
`GST_OBJECT_LOCK(self)` from earlier in the same function. That function
re-locks the identical, non-recursive `GST_OBJECT_LOCK` on the same element —
a deterministic self-deadlock, confirmed as a genuine GStreamer bug in this
version (1.28.3/1.28.4), not a timing race.

**Fix:** use `start-time-selection=first` instead (`participant.rs`,
`audiomixer` creation). It never calls `gst_element_get_current_running_time`;
it locks the *pad's* own object lock (a distinct mutex from the aggregator's),
and `gst_aggregator_wait_and_check` also special-cases `FIRST` mode to use a
plain cond-wait instead of the clock-deadline wait for a pad's first buffer —
which happens to sidestep the original "stalls after a few buffers" theory
too.

### Bug 2 — `appsink` needs a preroll buffer to reach `Playing`

Separately, `add_then_remove_participant_keeps_pipeline_playing` failed fast
(not hung) with the pipeline settling at `Paused` instead of `Playing`.
`GST_DEBUG=GST_STATES:6` showed both participants' `appsink` elements stuck
in an `ASYNC` state transition. `appsink`'s `async` property defaults to
`true` ("go asynchronously to PAUSED"), meaning it needs one real buffer to
finish preroll — but this test never pushes any RTP, so it never could.

**Fix:** `.property("async", false)` on `appsink` (`participant.rs`) — a
freshly-joined participant who hasn't spoken yet shouldn't block the whole
room's pipeline from reaching `Playing`.

### Dead ends (tried, not needed once the above were found)
- `min-upstream-latency` and `force-live=true` on `audiomixer` — seemed to
  help initially (changed the failure mode) but were band-aids around Bug 1
  before its real cause was found. Removed once `start-time-selection=first`
  fixed things directly; `force-live=true` in particular made every mixer
  busy-loop recalculating a clock deadline every ~10ms for its entire
  lifetime (even with no data), which measurably slowed the whole test suite.
- Inserting a `queue` element between each `tee` and `audiomixer` sink pad —
  still needed (fixes a real, separate stall: `tee` has no thread of its own),
  kept in `mixer.rs`.
- `pipeline.recalculate_latency()` after every `add_participant` — harmless,
  not required for the actual fix, left in place.

### Also fixed along the way (unrelated to `audiomixer`)
- Missing `payload` field (96–127 range) in the `appsrc` RTP caps — `rtpopusdepay`
  requires it and was rejecting every buffer with "not-negotiated" until added.
- Test harness was reusing one captured RTP packet with a duplicate sequence
  number 30 times — `rtpopusdepay` correctly dropped repeats as "old packet".
  Fixed by capturing a real sequence of 30 distinct packets instead.
- (Outside this ticket's scope, found while investigating suite runtime)
  `server/src/pages/chat/tests/*`: `handle.stop(true)` graceful shutdown
  combined with actix-web's default 30s `shutdown_timeout` made any chat
  integration test that left a WS connection open at teardown take ~30s
  longer than necessary. Fixed with `.shutdown_timeout(0)` on the test
  `HttpServer` builders — full server test suite went from ~61s to ~3.5s.

