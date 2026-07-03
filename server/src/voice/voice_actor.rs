use actix::{AsyncContext, Handler};
use actix_web_actors::ws;
use log::{info, warn};
use std::sync::Arc;

use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;

use crate::pages::chat::chat_actor::{CHAT_ROOMS, ChatWs, PushEvent};
use crate::voice::service::{
    self as voice_service, MAX_VOICE_PARTICIPANTS_PER_ROOM, PeerHandle, VoiceSessionState,
};

// ── Actor message: ask a ChatWs for its voice participant info ─────────────────

#[derive(actix::Message)]
#[rtype(result = "Option<(String, String)>")]
pub(crate) struct GetVoiceParticipant;

impl Handler<GetVoiceParticipant> for ChatWs {
    type Result = Option<(String, String)>;
    fn handle(&mut self, _: GetVoiceParticipant, _: &mut Self::Context) -> Self::Result {
        self.session
            .voice
            .as_ref()
            .map(|v| (v.sender_id.clone(), v.sender_name.clone()))
    }
}

// ── Voice participant list helper ─────────────────────────────────────────────

async fn voice_participants_in_room(room_id: &str) -> Vec<(String, String)> {
    let addrs = CHAT_ROOMS.connected_recipients(room_id);
    let mut participants = Vec::new();
    for addr in addrs {
        if let Ok(Some(p)) = addr.send(GetVoiceParticipant).await {
            participants.push(p);
        }
    }
    participants
}

// ── Voice handlers ────────────────────────────────────────────────────────────

impl ChatWs {
    pub(crate) fn on_voice_join(
        &mut self,
        request_id: Option<String>,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        let request_id_ref = request_id.as_deref();

        let (sender_id, sender_name) = match (
            self.session.sender_name(),
            Some(self.sender_id.clone()),
        ) {
            (Some(name), Some(id)) => (id, name),
            _ => {
                ctx.binary(voice_service::voice_error_payload(
                    request_id_ref,
                    "VOICE_NO_NICKNAME",
                ));
                return;
            }
        };

        if self.session.voice.is_some() {
            ctx.binary(voice_service::voice_error_payload(
                request_id_ref,
                "VOICE_ALREADY_JOINED",
            ));
            return;
        }

        let room_id = self.room_id.clone();
        let sender_id_clone = sender_id.clone();
        let sender_name_clone = sender_name.clone();

        self.session.voice = Some(VoiceSessionState {
            sender_id: sender_id.clone(),
            sender_name: sender_name.clone(),
            peer: None,
        });

        info!(
            "event=voice_join room_id={} sender_id={} sender_name={}",
            room_id, sender_id, sender_name
        );

        let addr = ctx.address();
        actix::spawn(async move {
            let mut participants = voice_participants_in_room(&room_id).await;

            if participants.len() > MAX_VOICE_PARTICIPANTS_PER_ROOM {
                addr.do_send(PushEvent(voice_service::voice_error_payload(
                    None,
                    "VOICE_ROOM_FULL",
                )));
                addr.do_send(RollbackVoiceJoin);
                return;
            }

            if !participants.iter().any(|(id, _)| id == &sender_id_clone) {
                participants.push((sender_id_clone, sender_name_clone));
            }

            let payload = voice_service::voice_state_payload(participants);
            ChatWs::broadcast_to_room(&room_id, payload);
        });
    }

    pub(crate) fn on_voice_leave(
        &mut self,
        _request_id: Option<String>,
        _ctx: &mut ws::WebsocketContext<Self>,
    ) {
        if self.session.voice.is_none() {
            return;
        }
        self.do_voice_leave();
    }

    /// Called both from on_voice_leave and from stopped() on disconnect.
    pub(crate) fn do_voice_leave(&mut self) {
        let Some(voice) = self.session.voice.take() else {
            return;
        };
        let room_id = self.room_id.clone();
        info!(
            "event=voice_leave room_id={} sender_id={}",
            room_id, self.sender_id
        );
        if let Some(peer) = voice.peer {
            actix::spawn(async move {
                if let Err(e) = peer.peer_connection.close().await {
                    warn!(
                        "event=voice_peer_close_error peer_id={} error={}",
                        peer.peer_id, e
                    );
                }
            });
        }
        actix::spawn(async move {
            let participants = voice_participants_in_room(&room_id).await;
            let payload = voice_service::voice_state_payload(participants);
            ChatWs::broadcast_to_room(&room_id, payload);
        });
    }

    pub(crate) fn on_voice_offer(
        &mut self,
        request_id: Option<String>,
        sdp: String,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        if self.session.voice.is_none() {
            ctx.binary(voice_service::voice_error_payload(
                request_id.as_deref(),
                "VOICE_NOT_JOINED",
            ));
            return;
        }
        let peer_id = self.sender_id.clone();
        let room_id = self.room_id.clone();
        let addr = ctx.address();

        actix::spawn(async move {
            let result = negotiate_offer(&peer_id, &room_id, sdp, addr.clone()).await;
            match result {
                Ok((peer_connection, answer_sdp)) => {
                    addr.do_send(VoiceOfferReady {
                        request_id,
                        peer: PeerHandle {
                            peer_connection,
                            peer_id,
                        },
                        answer_sdp,
                    });
                }
                Err(e) => {
                    warn!("event=voice_offer_error peer_id={} error={}", peer_id, e);
                    addr.do_send(VoiceOfferFailed { request_id });
                }
            }
        });
    }

    pub(crate) fn on_voice_ice(
        &mut self,
        request_id: Option<String>,
        candidate: String,
        sdp_mid: String,
        sdp_mline_idx: u32,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        let Some(voice) = self.session.voice.as_ref() else {
            ctx.binary(voice_service::voice_error_payload(
                request_id.as_deref(),
                "VOICE_NOT_JOINED",
            ));
            return;
        };
        let Some(peer) = voice.peer.as_ref() else {
            // ICE arriving before the offer/answer exchange completed — ignore.
            return;
        };
        let peer_connection = peer.peer_connection.clone();
        let peer_id = self.sender_id.clone();

        actix::spawn(async move {
            let candidate_init = RTCIceCandidateInit {
                candidate,
                sdp_mid: Some(sdp_mid),
                sdp_mline_index: Some(sdp_mline_idx as u16),
                username_fragment: None,
            };
            if let Err(e) = peer_connection.add_ice_candidate(candidate_init).await {
                warn!(
                    "event=voice_ice_error peer_id={} error={}",
                    peer_id, e
                );
            }
        });
    }
}

/// Perform the SDP offer/answer exchange and wire up ICE/track callbacks for a new peer.
/// Returns the connected `RTCPeerConnection` and the SDP answer to send back to the client.
async fn negotiate_offer(
    peer_id: &str,
    room_id: &str,
    offer_sdp: String,
    addr: actix::Addr<ChatWs>,
) -> Result<(Arc<RTCPeerConnection>, String), webrtc::Error> {
    let rtc = crate::voice::rtc_context();
    let peer_connection = Arc::new(rtc.api.new_peer_connection(rtc.config.clone()).await?);

    // Audio-only, receive-only transceiver so the SDP advertises audio receive capability.
    peer_connection
        .add_transceiver_from_kind(
            RTPCodecType::Audio,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                send_encodings: vec![],
            }),
        )
        .await?;

    let peer_id_for_ice = peer_id.to_string();
    let addr_for_ice = addr.clone();
    peer_connection.on_ice_candidate(Box::new(move |candidate| {
        let peer_id = peer_id_for_ice.clone();
        let addr = addr_for_ice.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return;
            };
            let Ok(init) = candidate.to_json() else {
                warn!("event=voice_ice_serialize_error peer_id={}", peer_id);
                return;
            };
            addr.do_send(PushEvent(voice_service::voice_ice_payload(
                &init.candidate,
                init.sdp_mid.as_deref().unwrap_or(""),
                init.sdp_mline_index.unwrap_or(0) as u32,
            )));
        })
    }));

    let peer_id_for_track = peer_id.to_string();
    let room_id_for_track = room_id.to_string();
    peer_connection.on_track(Box::new(move |track, _receiver, _transceiver| {
        let peer_id = peer_id_for_track.clone();
        let room_id = room_id_for_track.clone();
        Box::pin(async move {
            info!(
                "event=voice_track_received room_id={} peer_id={} kind={} codec={} ssrc={}",
                room_id,
                peer_id,
                track.kind(),
                track.codec().capability.mime_type,
                track.ssrc(),
            );
            // RTP reading loop will be added in VOICE-60.
        })
    }));

    peer_connection
        .set_remote_description(RTCSessionDescription::offer(offer_sdp)?)
        .await?;
    let answer = peer_connection.create_answer(None).await?;
    peer_connection
        .set_local_description(answer.clone())
        .await?;

    Ok((peer_connection, answer.sdp))
}

// ── Actor messages: async offer negotiation result delivery ───────────────────

#[derive(actix::Message)]
#[rtype(result = "()")]
struct VoiceOfferReady {
    request_id: Option<String>,
    peer: PeerHandle,
    answer_sdp: String,
}

impl Handler<VoiceOfferReady> for ChatWs {
    type Result = ();
    fn handle(&mut self, msg: VoiceOfferReady, ctx: &mut Self::Context) {
        if let Some(voice) = self.session.voice.as_mut() {
            voice.peer = Some(msg.peer);
        }
        ctx.binary(voice_service::voice_answer_payload(
            msg.request_id.as_deref(),
            &msg.answer_sdp,
        ));
    }
}

#[derive(actix::Message)]
#[rtype(result = "()")]
struct VoiceOfferFailed {
    request_id: Option<String>,
}

impl Handler<VoiceOfferFailed> for ChatWs {
    type Result = ();
    fn handle(&mut self, msg: VoiceOfferFailed, ctx: &mut Self::Context) {
        ctx.binary(voice_service::voice_error_payload(
            msg.request_id.as_deref(),
            "VOICE_OFFER_FAILED",
        ));
    }
}

// ── Rollback message (room full after optimistic join) ────────────────────────

#[derive(actix::Message)]
#[rtype(result = "()")]
struct RollbackVoiceJoin;

impl Handler<RollbackVoiceJoin> for ChatWs {
    type Result = ();
    fn handle(&mut self, _: RollbackVoiceJoin, _: &mut Self::Context) {
        self.session.voice = None;
        warn!(
            "event=voice_join_rolled_back room_id={} sender_id={} reason=VOICE_ROOM_FULL",
            self.room_id, self.sender_id
        );
    }
}

#[cfg(test)]
mod tests {
    use crate::chat::service::ChatSessionState;
    use crate::voice::service::VoiceSessionState;

    #[test]
    fn voice_session_state_starts_none() {
        let session = ChatSessionState::new();
        assert!(session.voice.is_none());
    }

    #[test]
    fn voice_session_state_set_and_clear() {
        let mut session = ChatSessionState::new();
        session.voice = Some(VoiceSessionState {
            sender_id: "id1".into(),
            sender_name: "Alice".into(),
            peer: None,
        });
        assert!(session.voice.is_some());
        session.voice = None;
        assert!(session.voice.is_none());
    }
}
