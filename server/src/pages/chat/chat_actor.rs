use actix::{Actor, Addr, AsyncContext, Handler, Message, StreamHandler};
use actix_web::web;
use actix_web_actors::ws;
use log::{info, warn};
use std::sync::LazyLock;

use crate::app::AppCtx;
use crate::attachments::service::UploadSessionState;
use crate::chat::service::{self as chat_service, ChatSessionState, RoomRegistry};

// Pull in impl blocks that extend ChatWs from their home modules
use crate::chat::attachments_actor as _;
use crate::chat::messaging_actor as _;
use crate::voice::voice_actor as _;

pub(crate) static CHAT_ROOMS: LazyLock<RoomRegistry<ChatWs>> = LazyLock::new(RoomRegistry::new);

#[derive(Message)]
#[rtype(result = "()")]
pub(crate) struct PushEvent(pub(crate) Vec<u8>);

#[derive(Message)]
#[rtype(result = "()")]
pub(crate) struct PushBinary(pub(crate) Vec<u8>);

pub(crate) struct ChatWs {
    pub(crate) app_ctx: web::Data<AppCtx>,
    pub(crate) room_id: String,
    pub(crate) sender_id: String,
    pub(crate) session: ChatSessionState,
    pub(crate) is_registered: bool,
    pub(crate) uploads: UploadSessionState,
}

// ── Room helpers ──────────────────────────────────────────────────────────────

impl ChatWs {
    pub(crate) fn send_error(
        room_id: &str,
        sender_id: &str,
        ctx: &mut ws::WebsocketContext<Self>,
        request_id: Option<&str>,
        code: &str,
        message: &str,
    ) {
        warn!(
            "event=chat_error room_id={} sender_id={} code={} request_id={}",
            room_id,
            sender_id,
            code,
            request_id.unwrap_or("null"),
        );
        ctx.binary(chat_service::error_payload(request_id, code, message));
    }

    pub(crate) fn register_connection(room_id: &str, addr: Addr<Self>) -> bool {
        CHAT_ROOMS.try_register_connection(room_id, addr, chat_service::MAX_OPEN_CONNECTIONS)
    }

    pub(crate) fn cleanup_room(room_id: &str) {
        CHAT_ROOMS.cleanup_room(room_id);
    }

    pub(crate) fn broadcast_to_room(room_id: &str, payload: Vec<u8>) {
        let recipients: Vec<Addr<Self>> = CHAT_ROOMS.connected_recipients(room_id);
        for addr in recipients {
            addr.do_send(PushEvent(payload.clone()));
        }
    }
}

// ── Actor lifecycle ───────────────────────────────────────────────────────────

impl Actor for ChatWs {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        if Self::register_connection(&self.room_id, ctx.address()) {
            self.is_registered = true;
            info!(
                "event=chat_connect room_id={} sender_id={}",
                self.room_id, self.sender_id
            );
            return;
        }
        warn!(
            "event=chat_error room_id={} sender_id={} code=CONNECTION_LIMIT_EXCEEDED request_id=null",
            self.room_id, self.sender_id
        );
        ctx.binary(chat_service::error_payload(
            None,
            "CONNECTION_LIMIT_EXCEEDED",
            "Too many open chat connections. Try again later.",
        ));
        ctx.close(Some(ws::CloseReason {
            code: ws::CloseCode::Policy,
            description: Some("CONNECTION_LIMIT_EXCEEDED".to_string()),
        }));
    }

    fn stopped(&mut self, _ctx: &mut Self::Context) {
        if self.is_registered {
            Self::cleanup_room(&self.room_id);
        }
        // Implicit voice leave on disconnect — broadcasts updated voice state to room.
        self.do_voice_leave();
        for upload_id in self.uploads.pending_upload_ids() {
            info!(
                "event=attachment_upload_cancelled upload_id={} sender_id={} reason=disconnect",
                upload_id, self.sender_id,
            );
        }
        info!(
            "event=chat_disconnect room_id={} sender_id={}",
            self.room_id, self.sender_id
        );
    }
}

// ── Push message handlers ─────────────────────────────────────────────────────

impl Handler<PushEvent> for ChatWs {
    type Result = ();
    fn handle(&mut self, msg: PushEvent, ctx: &mut Self::Context) -> Self::Result {
        ctx.binary(msg.0);
    }
}

impl Handler<PushBinary> for ChatWs {
    type Result = ();
    fn handle(&mut self, msg: PushBinary, ctx: &mut Self::Context) -> Self::Result {
        ctx.binary(msg.0);
    }
}

// ── WebSocket frame dispatcher ────────────────────────────────────────────────

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for ChatWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Binary(bytes)) => self.on_binary(&bytes, ctx),
            Ok(ws::Message::Close(reason)) => ctx.close(reason),
            Err(ws::ProtocolError::Overflow) => {
                Self::send_error(
                    &self.room_id,
                    &self.sender_id,
                    ctx,
                    None,
                    "BAD_PAYLOAD",
                    "Frame too large.",
                );
            }
            _ => {}
        }
    }
}
