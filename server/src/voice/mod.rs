pub mod service;
pub mod voice_actor;

use std::env;
use std::sync::{Arc, OnceLock};

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
}
