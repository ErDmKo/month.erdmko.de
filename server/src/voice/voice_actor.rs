use actix::{AsyncContext, Handler};
use actix_web::rt::task;
use actix_web_actors::ws;
use log::{info, warn};
use std::sync::Arc;

use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp::packet::Packet as RtpPacket;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc_util::{Marshal, Unmarshal};

use crate::pages::chat::chat_actor::{ChatWs, PushEvent};
use crate::voice::service::{self as voice_service, PeerHandle, VoiceSessionState};

// ── Voice handlers ────────────────────────────────────────────────────────────

impl ChatWs {
    pub(crate) fn on_voice_join(
        &mut self,
        request_id: Option<String>,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        let request_id_ref = request_id.as_deref();

        let (sender_id, sender_name) =
            match (self.session.sender_name(), Some(self.sender_id.clone())) {
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
        if let Err(code) =
            crate::voice::register_voice_participant(&room_id, &sender_id, &sender_name)
        {
            ctx.binary(voice_service::voice_error_payload(request_id_ref, code));
            return;
        }

        self.session.voice = Some(VoiceSessionState {
            sender_id: sender_id.clone(),
            sender_name: sender_name.clone(),
            peer: None,
        });

        info!(
            "event=voice_join room_id={} sender_id={} sender_name={}",
            room_id, sender_id, sender_name
        );

        let participants = crate::voice::get_voice_participants_in_room(&room_id);
        let payload = voice_service::voice_state_payload(participants);
        ChatWs::broadcast_to_room(&room_id, payload);
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
        let peer_id = self.sender_id.clone();
        crate::voice::unregister_voice_participant(&room_id, &peer_id);
        info!(
            "event=voice_leave room_id={} sender_id={}",
            room_id, self.sender_id
        );
        if let Some(peer) = voice.peer {
            let peer_connection = peer.peer_connection.clone();
            // Dropping `peer` aborts its inbound/outbound RTP loops (see
            // `PeerHandle`'s `Drop` impl) before we remove it from the
            // room's GStreamer state, so neither loop can race
            // `remove_participant` and grab a handle to a participant
            // that's mid-teardown.
            drop(peer);
            let room_id_for_leave = room_id.clone();
            let peer_id_for_leave = peer_id.clone();
            task::spawn_blocking(move || {
                crate::voice::leave_room(&room_id_for_leave, &peer_id_for_leave);
            });
            actix::spawn(async move {
                if let Err(e) = peer_connection.close().await {
                    warn!(
                        "event=voice_peer_close_error peer_id={} error={}",
                        peer_id, e
                    );
                }
            });
        }
        let participants = crate::voice::get_voice_participants_in_room(&room_id);
        let payload = voice_service::voice_state_payload(participants);
        ChatWs::broadcast_to_room(&room_id, payload);
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
                Ok((peer, answer_sdp)) => {
                    addr.do_send(VoiceOfferReady {
                        request_id,
                        peer,
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
                warn!("event=voice_ice_error peer_id={} error={}", peer_id, e);
            }
        });
    }
}

/// Perform the SDP offer/answer exchange and wire up ICE/track callbacks for a new peer.
/// Also joins `room_id`'s `RoomPipeline` (creating it if this is the first
/// participant) and starts the inbound (`OnTrack` → `push_rtp`) and outbound
/// (`pull_rtp` → outbound track) RTP loops. Returns the ready-to-use
/// `PeerHandle` and the SDP answer to send back to the client.
async fn negotiate_offer(
    peer_id: &str,
    room_id: &str,
    offer_sdp: String,
    addr: actix::Addr<ChatWs>,
) -> Result<(PeerHandle, String), webrtc::Error> {
    let rtc = crate::voice::rtc_context();
    let peer_connection = Arc::new(rtc.api.new_peer_connection(rtc.config.clone()).await?);

    // The browser's offer has exactly one `m=audio` line (its mic track,
    // `sendrecv` by default from a plain `peerConnection.addTrack`). An SDP
    // answer must have the same number of m-lines, in the same order, as
    // the offer — so we must NOT create a second, separate transceiver
    // here for our outbound mixed audio: `set_remote_description` below
    // will auto-create the one transceiver matching that single offered
    // section, and we attach our outbound track to *that same*
    // transceiver's sender afterwards (see `replace_track` below).
    // (An earlier version of this code called both
    // `add_transceiver_from_kind(.., Recvonly)` and
    // `add_transceiver_from_track(.., Sendonly)` here, which silently
    // produced an SDP answer with only the recvonly transceiver bound to
    // the offer's one m=audio section — the sendonly one was orphaned and
    // never appeared in the answer at all, so `peerConnection.ontrack`
    // never fired client-side and no audio ever reached the browser, even
    // though the GStreamer side worked perfectly.)

    // Outbound track carrying this participant's mix-minus output
    // (everyone else in the room, minus their own audio). `webrtc-rs` has
    // no `RTCRtpSender::send_rtp` — outbound RTP is written directly to
    // this `TrackLocalStaticRTP` handle instead (`write_rtp`, used below
    // in the outbound loop).
    let outbound_track = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_string(),
            clock_rate: 48000,
            channels: 1,
            ..Default::default()
        },
        "audio".to_string(),
        peer_id.to_string(),
    ));

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

    // Inbound loop: read RTP off the remote track and push it into this
    // participant's GStreamer inbound pipeline. `on_track` only fires once
    // negotiation/ICE has progressed far enough for media to actually flow,
    // which is after `negotiate_offer` itself returns — so the resulting
    // `JoinHandle` is written into `inbound_handle_cell` from inside the
    // callback rather than returned directly (see `PeerHandle`'s doc comment).
    let inbound_handle_cell: Arc<std::sync::Mutex<Option<task::JoinHandle<()>>>> =
        Arc::new(std::sync::Mutex::new(None));
    let inbound_handle_cell_for_track = inbound_handle_cell.clone();
    let peer_id_for_track = peer_id.to_string();
    let room_id_for_track = room_id.to_string();
    peer_connection.on_track(Box::new(move |track, _receiver, _transceiver| {
        let peer_id = peer_id_for_track.clone();
        let room_id = room_id_for_track.clone();
        let inbound_handle_cell = inbound_handle_cell_for_track.clone();
        Box::pin(async move {
            info!(
                "event=voice_track_received room_id={} peer_id={} kind={} codec={} ssrc={}",
                room_id,
                peer_id,
                track.kind(),
                track.codec().capability.mime_type,
                track.ssrc(),
            );
            // `on_track` is invoked by webrtc-rs's own executor, not necessarily on
            // this actix worker's LocalSet, so `actix::spawn` (== spawn_local) would
            // panic with "called from outside of a task::LocalSet" here — use plain
            // tokio::spawn, which needs no LocalSet (everything captured is Send).
            let handle = tokio::spawn(async move {
                loop {
                    match track.read_rtp().await {
                        Ok((packet, _attributes)) => {
                            let Ok(bytes) = packet.marshal() else {
                                continue;
                            };
                            // Look up (and immediately drop the room lock behind)
                            // a cloned participant handle rather than calling
                            // push_rtp while holding `VOICE_GST`'s lock — see
                            // `RoomPipeline::get_participant`'s doc comment.
                            match crate::voice::get_participant(&room_id, &peer_id) {
                                Some(participant) => participant.push_rtp(&bytes),
                                None => break, // room/participant gone — normal on teardown races
                            }
                        }
                        Err(_) => break, // track closed — normal on disconnect
                    }
                }
            });
            *inbound_handle_cell.lock().unwrap() = Some(handle);
        })
    }));

    peer_connection
        .set_remote_description(RTCSessionDescription::offer(offer_sdp)?)
        .await?;

    // Attach our outbound mixed-audio track to the transceiver that
    // `set_remote_description` just auto-created/matched for the offer's
    // one `m=audio` section, making that section carry both directions
    // (the browser's mic in, our mix-minus output out) instead of creating
    // a second, unmatched transceiver — see the comment above this
    // function's `outbound_track` construction for why that's required.
    let audio_transceiver = peer_connection
        .get_transceivers()
        .await
        .into_iter()
        .find(|t| t.kind() == RTPCodecType::Audio)
        .ok_or_else(|| {
            webrtc::Error::new(
                "no audio transceiver found after set_remote_description".to_string(),
            )
        })?;
    audio_transceiver
        .sender()
        .await
        .replace_track(Some(outbound_track.clone()))
        .await?;
    // `set_remote_description` creates/matches transceivers with a direction
    // inferred conservatively (observed to default to `Recvonly` even though
    // the offer's m=audio section was `sendrecv`) — attaching a track via
    // `replace_track` alone does NOT change the negotiated SDP direction, so
    // without this the answer keeps `a=recvonly` and the browser correctly
    // never fires `ontrack` for audio we never actually offered to send.
    // Confirmed via a live browser console log showing exactly `a=recvonly`
    // in the answer before this fix was added.
    audio_transceiver
        .set_direction(RTCRtpTransceiverDirection::Sendrecv)
        .await;

    let answer = peer_connection.create_answer(None).await?;
    peer_connection
        .set_local_description(answer.clone())
        .await?;

    // Only join the room's GStreamer pipeline once negotiation has fully
    // succeeded — every step above this point is fallible (`?`), and joining
    // any earlier would leak a `ParticipantPipeline` with no `PeerHandle`
    // ever created to call `leave_room` on an error return.
    crate::voice::join_room(room_id, peer_id);

    // Outbound loop: pull this participant's mixed-and-encoded output and
    // write it to the outbound track. `pull_rtp` is a real thread-blocking
    // GStreamer call (up to 50ms per attempt), so it runs inside
    // `spawn_blocking` rather than directly in this async task; the
    // participant handle is cloned out of the room registry per-iteration so
    // the room-wide lock is never held across that blocking call (again, see
    // `RoomPipeline::get_participant`'s doc comment).
    let peer_id_for_outbound = peer_id.to_string();
    let room_id_for_outbound = room_id.to_string();
    // Same reasoning as the inbound loop above — use plain tokio::spawn rather
    // than actix::spawn/spawn_local.
    let outbound_handle = tokio::spawn(async move {
        let mut sent_count: u64 = 0;
        loop {
            let Some(participant) =
                crate::voice::get_participant(&room_id_for_outbound, &peer_id_for_outbound)
            else {
                break; // participant removed from the room — normal on teardown
            };
            let bytes = match task::spawn_blocking(move || participant.pull_rtp()).await {
                Ok(bytes) => bytes,
                Err(_) => break, // blocking task panicked or was cancelled
            };
            let Some(bytes) = bytes else {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                continue;
            };
            let Ok(packet) = RtpPacket::unmarshal(&mut bytes.as_slice()) else {
                continue;
            };
            match outbound_track.write_rtp(&packet).await {
                Ok(_) => {
                    sent_count += 1;
                    // Log the first packet immediately (proves the outbound
                    // path is alive at all) then a heartbeat every 100
                    // packets (~2s of Opus audio) rather than every packet.
                    if sent_count == 1 || sent_count % 100 == 0 {
                        info!(
                            "event=voice_outbound_sent peer_id={} count={}",
                            peer_id_for_outbound, sent_count
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        "event=voice_outbound_write_error peer_id={} error={}",
                        peer_id_for_outbound, e
                    );
                }
            }
        }
    });

    Ok((
        PeerHandle {
            peer_connection,
            peer_id: peer_id.to_string(),
            inbound_handle: inbound_handle_cell,
            outbound_handle: Some(outbound_handle),
        },
        answer.sdp,
    ))
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
            ctx.binary(voice_service::voice_answer_payload(
                msg.request_id.as_deref(),
                &msg.answer_sdp,
            ));
        } else {
            // User left voice while negotiate_offer was in flight;
            // clean up the GStreamer room pipeline that negotiate_offer joined.
            let room_id = self.room_id.clone();
            let peer_id = msg.peer.peer_id.clone();
            crate::voice::unregister_voice_participant(&room_id, &peer_id);
            drop(msg.peer);
            task::spawn_blocking(move || {
                crate::voice::leave_room(&room_id, &peer_id);
            });
        }
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
