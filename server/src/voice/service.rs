use prost::Message;

use crate::generated::chat::{
    ServerFrame, ServerVoiceAnswer, ServerVoiceError, ServerVoiceIce, ServerVoiceState,
    VoiceParticipant, server_frame,
};

pub const MAX_VOICE_PARTICIPANTS_PER_ROOM: usize = 8;

pub struct VoiceSessionState {
    pub sender_id: String,
    pub sender_name: String,
    // peer_connection and task handles will be added in VOICE-40/VOICE-60
}

// ── Server → Client voice payload builders ────────────────────────────────────

fn server_frame(payload: server_frame::Payload) -> Vec<u8> {
    ServerFrame {
        payload: Some(payload),
    }
    .encode_to_vec()
}

pub fn voice_state_payload(participants: Vec<(String, String)>) -> Vec<u8> {
    server_frame(server_frame::Payload::VoiceState(ServerVoiceState {
        participants: participants
            .into_iter()
            .map(|(sender_id, sender_name)| VoiceParticipant {
                sender_id,
                sender_name,
            })
            .collect(),
    }))
}

pub fn voice_answer_payload(request_id: Option<&str>, sdp: &str) -> Vec<u8> {
    server_frame(server_frame::Payload::VoiceAnswer(ServerVoiceAnswer {
        request_id: request_id.unwrap_or("").to_string(),
        sdp: sdp.to_string(),
    }))
}

pub fn voice_ice_payload(candidate: &str, sdp_mid: &str, sdp_mline_idx: u32) -> Vec<u8> {
    server_frame(server_frame::Payload::VoiceIce(ServerVoiceIce {
        candidate: candidate.to_string(),
        sdp_mid: sdp_mid.to_string(),
        sdp_mline_idx,
    }))
}

pub fn voice_error_payload(request_id: Option<&str>, code: &str) -> Vec<u8> {
    server_frame(server_frame::Payload::VoiceError(ServerVoiceError {
        request_id: request_id.unwrap_or("").to_string(),
        code: code.to_string(),
    }))
}
