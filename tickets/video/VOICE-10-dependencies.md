---
title: "Voice Dependencies"
ticket: "VOICE-10"
status: "completed"
draft: false
weight: 10
---

# VOICE-10 Dependencies

## Depends on
- none

## Goal
Add the crates required for WebRTC and GStreamer audio to the existing server.
No new HTTP framework — the existing Actix-Web server is reused.

## Scope

Add to `server/Cargo.toml`:

```toml
# WebRTC
webrtc = "0.11"

# GStreamer audio pipeline
gstreamer = "0.23"
gstreamer-app = "0.23"
gstreamer-audio = "0.23"
```

Do NOT add `warp`, `axum`, `tokio` (Actix already pulls it), or any video crates (`gstreamer-video`, `gstreamer-pbutils`).

Add a smoke-test module `server/src/voice/mod.rs` that calls `gstreamer::init()` and compiles without error.
Register the module in `server/src/main.rs` (`mod voice;`) but do not wire any routes yet.

## Deliverables
- `server/Cargo.toml` updated with 4 new crates
- `server/src/voice/mod.rs` — empty module with `gstreamer::init()` call in a `#[cfg(test)]` test
- `cargo check` passes

## Tests
- `cargo check` — no compilation errors
- `cargo test -p server voice::tests` — GStreamer init smoke test passes

## Acceptance
- All four crates resolve and compile
- Existing chat tests still pass (`cargo test -p server`)
