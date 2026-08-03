pub mod mixer;
pub mod participant;

use std::collections::HashMap;

use gstreamer::prelude::*;

use mixer::MixLink;
pub use participant::ParticipantPipeline;

/// Top-level GStreamer state for one voice room: one `Pipeline`, N participants,
/// each mix-minus-linked to every other participant.
pub struct RoomPipeline {
    pipeline: gstreamer::Pipeline,
    participants: HashMap<String, ParticipantPipeline>,
    // (source_peer_id, dest_peer_id) -> link, so B receives A's audio via B's mixer.
    links: HashMap<(String, String), MixLink>,
}

impl RoomPipeline {
    pub fn new() -> Self {
        let pipeline = gstreamer::Pipeline::new();
        pipeline
            .set_state(gstreamer::State::Playing)
            .expect("voice room pipeline failed to reach Playing state");
        Self {
            pipeline,
            participants: HashMap::new(),
            links: HashMap::new(),
        }
    }

    /// Add a new participant: build their elements, then mix-minus-link them
    /// with every already-connected participant in both directions.
    pub fn add_participant(&mut self, peer_id: &str) -> ParticipantPipeline {
        let new_participant = ParticipantPipeline::new(&self.pipeline, peer_id)
            .expect("failed to build participant GStreamer pipeline");

        for (other_id, other) in self.participants.iter() {
            // new participant's audio -> other's mixer
            if let Ok(link) = mixer::link_tee_to_mixer(
                peer_id,
                other_id,
                &self.pipeline,
                &new_participant.tee,
                &other.mixer,
            ) {
                self.links
                    .insert((peer_id.to_string(), other_id.clone()), link);
            }
            // other's audio -> new participant's mixer
            if let Ok(link) = mixer::link_tee_to_mixer(
                other_id,
                peer_id,
                &self.pipeline,
                &other.tee,
                &new_participant.mixer,
            ) {
                self.links
                    .insert((other_id.clone(), peer_id.to_string()), link);
            }
        }

        self.participants
            .insert(peer_id.to_string(), new_participant.clone());
        // Adding live elements after the pipeline is already Playing can leave
        // downstream live aggregators (audiomixer) with a stale latency figure;
        // force a recalculation so they don't stall waiting on the wrong deadline.
        let _ = self.pipeline.recalculate_latency();

        // Diagnostic: play a short sine tone directly into the new
        // participant's own mixer. This proves the GStreamer side (mixer →
        // encode → appsink → outbound RTP → browser) works end-to-end,
        // independent of microphone input or any other participant's link —
        // if you don't hear this on join, the problem is downstream of
        // GStreamer (browser audio element, ICE/RTP delivery), not the
        // mixing pipeline itself.
        let _ = mixer::play_test_tone(
            &self.pipeline,
            &new_participant.mixer,
            std::time::Duration::from_secs(2),
        );

        new_participant
    }

    /// Remove a participant: unlink all mix-minus pads, drain and tear down
    /// their elements. The pipeline itself remains in `Playing` state.
    pub fn remove_participant(&mut self, peer_id: &str) {
        let Some(participant) = self.participants.remove(peer_id) else {
            return;
        };

        let stale_keys: Vec<(String, String)> = self
            .links
            .keys()
            .filter(|(src, dst)| src == peer_id || dst == peer_id)
            .cloned()
            .collect();

        for key in stale_keys {
            if let Some(link) = self.links.remove(&key) {
                let (src, dst) = &key;
                if src == peer_id {
                    if let Some(other) = self.participants.get(dst) {
                        mixer::unlink(&link, &self.pipeline, &participant.tee, &other.mixer);
                    }
                } else if let Some(other) = self.participants.get(src) {
                    mixer::unlink(&link, &self.pipeline, &other.tee, &participant.mixer);
                }
            }
        }

        participant.teardown(&self.pipeline);
    }

    /// Push a chunk of RTP/Opus bytes into `peer_id`'s inbound pipeline.
    /// No-op (does not panic) if the participant is unknown.
    pub fn push_rtp(&self, peer_id: &str, data: &[u8]) {
        if let Some(participant) = self.participants.get(peer_id) {
            participant.push_rtp(data);
        }
    }

    /// Pull one RTP/Opus buffer of `peer_id`'s mixed-and-encoded output, if available.
    pub fn pull_rtp(&self, peer_id: &str) -> Option<Vec<u8>> {
        self.participants.get(peer_id)?.pull_rtp()
    }

    /// Clone out a participant's handle. `ParticipantPipeline` is cheap to
    /// clone (refcounted GStreamer handles), so callers holding the
    /// `VOICE_GST` room-registry lock should use this to get their own copy
    /// and drop the lock *before* calling `push_rtp`/`pull_rtp` on it —
    /// `pull_rtp` in particular blocks the calling thread for up to 50ms
    /// internally, and doing that while still holding the global room lock
    /// would serialize every other participant's inbound/outbound loop (and
    /// any join/leave) behind it.
    pub fn get_participant(&self, peer_id: &str) -> Option<ParticipantPipeline> {
        self.participants.get(peer_id).cloned()
    }

    /// Whether this room has no participants left (used to decide when to
    /// drop the `RoomPipeline` from the global registry).
    pub fn is_empty(&self) -> bool {
        self.participants.is_empty()
    }
}

impl Default for RoomPipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for RoomPipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gstreamer::State::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_opus_rtp_packets(count: i32) -> Vec<Vec<u8>> {
        // Generate a sequence of real Opus-in-RTP packets (increasing seqnum,
        // as rtpopusdepay requires) using a short throwaway pipeline:
        // audiotestsrc (silence) ! opusenc ! rtpopuspay ! appsink
        crate::voice::init();
        let pipeline = gstreamer::Pipeline::new();
        let src = gstreamer::ElementFactory::make("audiotestsrc")
            .property_from_str("wave", "silence")
            .property("num-buffers", count)
            .build()
            .unwrap();
        let convert = gstreamer::ElementFactory::make("audioconvert")
            .build()
            .unwrap();
        let enc = gstreamer::ElementFactory::make("opusenc").build().unwrap();
        let pay = gstreamer::ElementFactory::make("rtpopuspay")
            .build()
            .unwrap();
        let sink = gstreamer::ElementFactory::make("appsink")
            .property("sync", false)
            .build()
            .unwrap();
        pipeline
            .add_many([&src, &convert, &enc, &pay, &sink])
            .unwrap();
        gstreamer::Element::link_many([&src, &convert, &enc, &pay, &sink]).unwrap();
        pipeline.set_state(gstreamer::State::Playing).unwrap();

        let appsink = sink.dynamic_cast::<gstreamer_app::AppSink>().unwrap();
        let mut packets = Vec::new();
        for _ in 0..count {
            let Some(sample) = appsink.try_pull_sample(gstreamer::ClockTime::from_seconds(5))
            else {
                break;
            };
            let buffer = sample.buffer().unwrap();
            packets.push(buffer.map_readable().unwrap().as_slice().to_vec());
        }
        pipeline.set_state(gstreamer::State::Null).unwrap();
        assert!(
            !packets.is_empty(),
            "failed to capture any test Opus RTP packets"
        );
        packets
    }

    /// Two-participant end-to-end audio routing through the mix-minus pipeline.
    /// See "Known Issues" in tickets/video/VOICE-50-gstreamer-engine.md for the
    /// history of the `audiomixer` self-deadlock this used to hit.
    #[test]
    fn two_participant_pipeline_routes_audio() {
        crate::voice::init();
        let mut room = RoomPipeline::new();
        room.add_participant("A");
        room.add_participant("B");

        let packets = make_opus_rtp_packets(30);
        for packet in &packets {
            room.push_rtp("A", packet);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let mut received = None;
        for _ in 0..40 {
            if let Some(buf) = room.pull_rtp("B") {
                received = Some(buf);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            received.is_some(),
            "expected participant B's appsink to produce a buffer after A pushed audio"
        );
    }

    /// Adding then removing a participant leaves the pipeline in `Playing`,
    /// even though no RTP is ever pushed (appsink must not require a preroll
    /// buffer to settle — see `async: false` in `ParticipantPipeline::new`).
    #[test]
    fn add_then_remove_participant_keeps_pipeline_playing() {
        crate::voice::init();
        let mut room = RoomPipeline::new();
        room.add_participant("A");
        room.add_participant("B");
        room.remove_participant("A");

        // Block until any pending async state change settles.
        let (_, current, _) = room.pipeline.state(gstreamer::ClockTime::NONE);
        assert_eq!(current, gstreamer::State::Playing);
    }

    #[test]
    fn push_rtp_with_malformed_bytes_does_not_panic() {
        crate::voice::init();
        let mut room = RoomPipeline::new();
        room.add_participant("A");
        room.push_rtp("A", &[0xFF, 0x00, 0x01, 0x02]);
        // Also verify pushing to an unknown participant is a safe no-op.
        room.push_rtp("does-not-exist", &[0x00]);
    }
}
