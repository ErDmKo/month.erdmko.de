pub mod gst;
pub mod service;
pub mod voice_actor;

use std::collections::HashMap;
use std::env;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use gst::{ParticipantPipeline, RoomPipeline};

use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::{API, APIBuilder};
use webrtc::ice::udp_network::{EphemeralUDP, UDPNetwork};
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;
use webrtc::peer_connection::configuration::RTCConfiguration;

pub struct VoiceConfig {
    pub public_ip: String,
    pub rtp_port_min: u16,
    pub rtp_port_max: u16,
}

impl VoiceConfig {
    pub fn from_env() -> Self {
        let public_ip =
            env::var("PUBLIC_IP").unwrap_or_else(|_| "127.0.0.1".to_string());

        let rtp_port_min: u16 = env::var("RTP_PORT_MIN")
            .unwrap_or_else(|_| "50000".to_string())
            .parse()
            .expect("RTP_PORT_MIN must be a valid u16 port number");

        let rtp_port_max: u16 = env::var("RTP_PORT_MAX")
            .unwrap_or_else(|_| "50100".to_string())
            .parse()
            .expect("RTP_PORT_MAX must be a valid u16 port number");

        assert!(
            rtp_port_min < rtp_port_max,
            "RTP_PORT_MIN ({rtp_port_min}) must be less than RTP_PORT_MAX ({rtp_port_max})"
        );

        Self {
            public_ip,
            rtp_port_min,
            rtp_port_max,
        }
    }
}

pub fn init() {
    gstreamer::init().expect("GStreamer initialization failed");
}

// ── Per-room GStreamer pipeline registry ──────────────────────────────────────

/// One `RoomPipeline` per active voice room. Created on first participant
/// join, dropped when the last participant leaves (see `leave_room`).
static VOICE_GST: LazyLock<Mutex<HashMap<String, RoomPipeline>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Join `peer_id` to `room_id`'s voice pipeline, creating the room's
/// `RoomPipeline` if this is the first participant. Returns the new
/// participant's GStreamer handle (cheap to clone, used by the caller's
/// inbound/outbound RTP loops).
pub fn join_room(room_id: &str, peer_id: &str) -> ParticipantPipeline {
    let mut rooms = VOICE_GST.lock().unwrap();
    let room = rooms
        .entry(room_id.to_string())
        .or_insert_with(RoomPipeline::new);
    room.add_participant(peer_id)
}

/// Remove `peer_id` from `room_id`'s voice pipeline. Drops the room's
/// `RoomPipeline` entirely if it was the last participant.
pub fn leave_room(room_id: &str, peer_id: &str) {
    let mut rooms = VOICE_GST.lock().unwrap();
    let Some(room) = rooms.get_mut(room_id) else {
        return;
    };
    room.remove_participant(peer_id);
    if room.is_empty() {
        rooms.remove(room_id);
    }
}

/// Look up a live participant's GStreamer handle without holding the
/// registry lock any longer than the lookup+clone itself. Callers must not
/// call GStreamer methods on the handle while still holding `VOICE_GST`'s
/// lock — see the comment on `RoomPipeline::get_participant`.
pub fn get_participant(room_id: &str, peer_id: &str) -> Option<ParticipantPipeline> {
    VOICE_GST
        .lock()
        .unwrap()
        .get(room_id)?
        .get_participant(peer_id)
}

/// Shared WebRTC context — built once at startup from [`VoiceConfig`] and
/// reused for every peer connection.
pub struct VoiceRtcContext {
    pub api: Arc<API>,
    pub config: RTCConfiguration,
}

static VOICE_RTC: OnceLock<VoiceRtcContext> = OnceLock::new();

/// Build the shared WebRTC `API` + `RTCConfiguration` from the given [`VoiceConfig`].
/// Must be called once at startup before any peer connection is created.
pub fn init_rtc(cfg: &VoiceConfig) {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .expect("failed to register default WebRTC codecs");

    let mut setting_engine = SettingEngine::default();
    // Always announce PUBLIC_IP in ICE candidates instead of the VPS's private NIC address.
    setting_engine.set_nat_1to1_ips(vec![cfg.public_ip.clone()], RTCIceCandidateType::Host);
    setting_engine.set_udp_network(UDPNetwork::Ephemeral(
        EphemeralUDP::new(cfg.rtp_port_min, cfg.rtp_port_max)
            .expect("invalid RTP_PORT_MIN/RTP_PORT_MAX range"),
    ));

    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_setting_engine(setting_engine)
        .build();

    let config = RTCConfiguration {
        ice_servers: vec![], // no external STUN needed — NAT1To1IPs handles it
        ..Default::default()
    };

    let _ = VOICE_RTC.set(VoiceRtcContext {
        api: Arc::new(api),
        config,
    });
}

/// Access the shared WebRTC context. Panics if [`init_rtc`] was not called at startup.
pub fn rtc_context() -> &'static VoiceRtcContext {
    VOICE_RTC
        .get()
        .expect("voice RTC context not initialized; call voice::init_rtc() at startup")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gstreamer_init_smoke() {
        gstreamer::init().expect("GStreamer init failed");
    }

    #[test]
    fn voice_config_from_env() {
        unsafe {
            std::env::set_var("PUBLIC_IP", "1.2.3.4");
            std::env::set_var("RTP_PORT_MIN", "50000");
            std::env::set_var("RTP_PORT_MAX", "50100");
        }
        let cfg = VoiceConfig::from_env();
        assert_eq!(cfg.public_ip, "1.2.3.4");
        assert_eq!(cfg.rtp_port_min, 50000);
        assert_eq!(cfg.rtp_port_max, 50100);
    }

    #[test]
    fn voice_config_defaults_ports() {
        unsafe {
            std::env::set_var("PUBLIC_IP", "5.6.7.8");
            std::env::remove_var("RTP_PORT_MIN");
            std::env::remove_var("RTP_PORT_MAX");
        }
        let cfg = VoiceConfig::from_env();
        assert_eq!(cfg.rtp_port_min, 50000);
        assert_eq!(cfg.rtp_port_max, 50100);
    }

    #[test]
    fn voice_config_defaults_public_ip() {
        unsafe {
            std::env::remove_var("PUBLIC_IP");
        }
        let cfg = VoiceConfig::from_env();
        assert_eq!(cfg.public_ip, "127.0.0.1");
    }

    // `VOICE_GST` is a single process-wide registry shared by every test in
    // this binary (tests run in parallel by default), so each test below
    // uses its own unique room_id to avoid interfering with the others.

    #[test]
    fn join_room_creates_pipeline_and_get_participant_finds_it() {
        init();
        let room_id = "test-room-join-room-creates-pipeline";
        join_room(room_id, "A");
        assert!(get_participant(room_id, "A").is_some());
        assert!(get_participant(room_id, "does-not-exist").is_none());
        leave_room(room_id, "A"); // cleanup so this room doesn't linger for other test runs
    }

    #[test]
    fn leave_room_removes_participant_and_drops_empty_room() {
        init();
        let room_id = "test-room-leave-room-removes-participant";
        join_room(room_id, "A");
        join_room(room_id, "B");

        leave_room(room_id, "A");
        assert!(get_participant(room_id, "A").is_none());
        assert!(
            get_participant(room_id, "B").is_some(),
            "B should still be in the room after A leaves"
        );

        leave_room(room_id, "B");
        // Room is now empty and should have been dropped from the registry;
        // any lookup on it (even for a peer that never existed) is a no-op.
        assert!(get_participant(room_id, "B").is_none());
        assert!(!VOICE_GST.lock().unwrap().contains_key(room_id));
    }

    #[test]
    fn leave_room_on_unknown_room_or_peer_does_not_panic() {
        init();
        leave_room("test-room-that-was-never-joined", "A");
        let room_id = "test-room-leave-unknown-peer";
        join_room(room_id, "A");
        leave_room(room_id, "does-not-exist");
        assert!(get_participant(room_id, "A").is_some());
        leave_room(room_id, "A");
    }
}
