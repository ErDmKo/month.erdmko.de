use actix_web::rt::task::JoinHandle;
use prost::Message;
use std::sync::{Arc, Mutex};
use webrtc::peer_connection::RTCPeerConnection;

use crate::generated::chat::{
    ServerFrame, ServerVoiceAnswer, ServerVoiceError, ServerVoiceIce, ServerVoiceState,
    VoiceParticipant, server_frame,
};

pub const MAX_VOICE_PARTICIPANTS_PER_ROOM: usize = 8;

/// A live WebRTC peer connection tied to one voice session, plus the two
/// background tokio tasks feeding audio between it and the room's
/// `RoomPipeline` (see `crate::voice::gst`). Both are aborted on disconnect
/// (see `ChatWs::do_voice_leave`) — cancellation is cooperative in the sense
/// that `read_rtp()`/`pull_rtp()` loops also exit on their own once the
/// track closes or the participant is removed from the room, but `abort()`
/// guarantees they stop immediately rather than racing the natural exit.
///
/// `inbound_handle` is an `Arc<Mutex<..>>` rather than a plain `JoinHandle`
/// because the inbound loop is only spawned once WebRTC's `on_track`
/// callback actually fires — which happens asynchronously, after this
/// `PeerHandle` is already constructed and stored on the session. The same
/// `Arc` is handed to the `on_track` closure so it can populate the handle
/// once the loop starts; `outbound_handle` has no such gap since it's spawned
/// synchronously before `negotiate_offer` returns.
pub struct PeerHandle {
    pub peer_connection: Arc<RTCPeerConnection>,
    pub peer_id: String,
    pub inbound_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    pub outbound_handle: Option<JoinHandle<()>>,
}

impl Drop for PeerHandle {
    fn drop(&mut self) {
        if let Some(handle) = self.inbound_handle.lock().unwrap().take() {
            handle.abort();
        }
        if let Some(handle) = self.outbound_handle.take() {
            handle.abort();
        }
    }
}

pub struct VoiceSessionState {
    pub sender_id: String,
    pub sender_name: String,
    pub peer: Option<PeerHandle>,
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
