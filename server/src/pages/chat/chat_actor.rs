use actix::{Actor, ActorContext, Addr, AsyncContext, Handler, Message, StreamHandler};
use actix_web::web;
use actix_web_actors::ws;
use log::{info, warn};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crate::app::AppCtx;
use crate::attachments::service::UploadSessionState;
use crate::chat::service::{self as chat_service, ChatSessionState, RoomRegistry};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) static CHAT_ROOMS: LazyLock<RoomRegistry<ChatWs>> = LazyLock::new(RoomRegistry::new);

#[derive(Message)]
#[rtype(result = "()")]
pub(crate) struct PushEvent(pub(crate) Vec<u8>);

#[derive(Message)]
#[rtype(result = "()")]
pub(crate) struct BroadcastEvent(pub(crate) Vec<u8>);

#[derive(Message)]
#[rtype(result = "()")]
pub(crate) struct PushBinary(pub(crate) Vec<u8>);

pub(crate) struct ChatWs {
    pub(crate) app_ctx: web::Data<AppCtx>,
    pub(crate) room_id: String,
    pub(crate) sender_id: String,
    pub(crate) session_token: String,
    pub(crate) session: ChatSessionState,
    pub(crate) is_registered: bool,
    pub(crate) uploads: UploadSessionState,
    pub(crate) hb: Instant,
}

// ── Room helpers ──────────────────────────────────────────────────────────────

impl ChatWs {
    pub(crate) fn verify_session_and_access(
        &self,
        conn: &rusqlite::Connection,
        now_unix: i64,
    ) -> Result<crate::auth::db::WalletProfile, (&'static str, &'static str)> {
        let wallet = crate::auth::db::get_valid_session_wallet(conn, &self.session_token, now_unix)
            .map_err(|_| ("INTERNAL", "Failed to verify auth session."))?;
        let Some(wallet) = wallet else {
            return Err(("UNAUTHORIZED", "Session is invalid or expired."));
        };
        if wallet != self.sender_id {
            return Err(("UNAUTHORIZED", "Session wallet mismatch."));
        }
        let profile = crate::auth::db::get_wallet_profile(conn, &self.sender_id, now_unix)
            .map_err(|_| ("INTERNAL", "Failed to query wallet profile."))?;
        if !profile.has_active_access {
            return Err((
                "PAYMENT_REQUIRED",
                "Active paid access is required to join the room.",
            ));
        }
        Ok(profile)
    }

    pub(crate) fn verify_active_token(
        &mut self,
        request_id: Option<&str>,
        ctx: &mut ws::WebsocketContext<Self>,
    ) -> bool {
        let now_unix = chrono::Utc::now().timestamp();
        let conn = match self.app_ctx.pool.get() {
            Ok(c) => c,
            Err(err) => {
                warn!(
                    "event=chat_error room_id={} sender_id={} code=INTERNAL request_id={} error={:?}",
                    self.room_id,
                    self.sender_id,
                    request_id.unwrap_or("null"),
                    err
                );
                Self::send_error(
                    &self.room_id,
                    &self.sender_id,
                    ctx,
                    request_id,
                    "INTERNAL",
                    "Failed to acquire DB connection.",
                );
                return false;
            }
        };

        if let Err((code, message)) = self.verify_session_and_access(&conn, now_unix) {
            drop(conn);
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                request_id,
                code,
                message,
            );
            if code == "UNAUTHORIZED" || code == "PAYMENT_REQUIRED" {
                self.close_for_revoked_access(code, ctx);
            }
            return false;
        }
        true
    }

    pub(crate) fn close_for_revoked_access(
        &mut self,
        code: &'static str,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        Self::remove_connection(&self.room_id, &ctx.address());
        self.is_registered = false;
        self.do_voice_leave();
        ctx.close(Some(ws::CloseReason {
            code: ws::CloseCode::Policy,
            description: Some(code.to_string()),
        }));
        ctx.stop();
    }

    pub(crate) fn on_ping(
        &mut self,
        request_id: Option<String>,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        if self.verify_active_token(request_id.as_deref(), ctx) {
            self.hb = Instant::now();
        }
    }

    pub(crate) fn require_joined_member(
        &mut self,
        request_id: Option<&str>,
        ctx: &mut ws::WebsocketContext<Self>,
    ) -> Option<String> {
        let Some(sender_name) = self.session.sender_name() else {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                request_id,
                "VALIDATION_ERROR",
                "Join the room before performing this action.",
            );
            return None;
        };
        if !self.verify_active_token(request_id, ctx) {
            return None;
        }
        Some(sender_name)
    }

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

    pub(crate) fn register_connection(addr: Addr<Self>) -> bool {
        CHAT_ROOMS.try_register_connection(addr, chat_service::MAX_OPEN_CONNECTIONS)
    }

    pub(crate) fn register_room_member(room_id: &str, addr: Addr<Self>) {
        CHAT_ROOMS.register_room_member(room_id, addr);
    }

    pub(crate) fn remove_connection(room_id: &str, addr: &Addr<Self>) {
        CHAT_ROOMS.remove_connection(room_id, addr);
    }

    pub(crate) fn broadcast_to_room(room_id: &str, payload: Vec<u8>) {
        let recipients: Vec<Addr<Self>> = CHAT_ROOMS.connected_recipients(room_id);
        for addr in recipients {
            addr.do_send(BroadcastEvent(payload.clone()));
        }
    }

    fn start_heartbeat(&self, ctx: &mut ws::WebsocketContext<Self>) {
        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            if Instant::now().duration_since(act.hb) > CLIENT_TIMEOUT {
                info!(
                    "event=chat_timeout room_id={} sender_id={} reason=heartbeat_failed",
                    act.room_id, act.sender_id
                );
                Self::remove_connection(&act.room_id, &ctx.address());
                act.is_registered = false;
                act.do_voice_leave();
                ctx.close(Some(ws::CloseReason {
                    code: ws::CloseCode::Policy,
                    description: Some("HEARTBEAT_TIMEOUT".to_string()),
                }));
                ctx.stop();
                return;
            }
            let _ = act.verify_active_token(None, ctx);
        });
    }
}

// ── Actor lifecycle ───────────────────────────────────────────────────────────

impl Actor for ChatWs {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        self.hb = Instant::now();
        self.start_heartbeat(ctx);
        if Self::register_connection(ctx.address()) {
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

    fn stopped(&mut self, ctx: &mut Self::Context) {
        if self.is_registered {
            Self::remove_connection(&self.room_id, &ctx.address());
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

impl Handler<BroadcastEvent> for ChatWs {
    type Result = ();
    fn handle(&mut self, msg: BroadcastEvent, ctx: &mut Self::Context) -> Self::Result {
        if !self.verify_active_token(None, ctx) {
            return;
        }
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
            Ok(ws::Message::Binary(bytes)) => {
                self.on_binary(&bytes, ctx);
            }
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop();
            }
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
