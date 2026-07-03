pub mod service;
pub mod voice_actor;

use std::env;

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
