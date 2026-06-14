use actix::{AsyncContext, Handler};
use actix_web_actors::ws;
use log::{info, warn};

use crate::voice::service::{self as voice_service, VoiceSessionState, MAX_VOICE_PARTICIPANTS_PER_ROOM};
use crate::pages::chat::chat_actor::{CHAT_ROOMS, ChatWs, PushEvent};

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
        if self.session.voice.take().is_none() {
            return;
        }
        let room_id = self.room_id.clone();
        info!(
            "event=voice_leave room_id={} sender_id={}",
            room_id, self.sender_id
        );
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
        warn!(
            "event=voice_offer_stub room_id={} sender_id={} sdp_len={}",
            self.room_id, self.sender_id, sdp.len()
        );
        ctx.binary(voice_service::voice_answer_payload(
            request_id.as_deref(),
            "stub-answer",
        ));
    }

    pub(crate) fn on_voice_ice(
        &mut self,
        request_id: Option<String>,
        candidate: String,
        sdp_mid: String,
        sdp_mline_idx: u32,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        if self.session.voice.is_none() {
            ctx.binary(voice_service::voice_error_payload(
                request_id.as_deref(),
                "VOICE_NOT_JOINED",
            ));
            return;
        }
        info!(
            "event=voice_ice_stub room_id={} sender_id={} candidate={} sdp_mid={} idx={}",
            self.room_id, self.sender_id, candidate, sdp_mid, sdp_mline_idx
        );
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
        });
        assert!(session.voice.is_some());
        session.voice = None;
        assert!(session.voice.is_none());
    }
}
