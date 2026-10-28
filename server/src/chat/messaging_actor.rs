use actix::AsyncContext;
use actix_web_actors::ws;
use chrono::Utc;
use log::{info, warn};

use crate::auth::db::{get_wallet_profile, set_wallet_nickname};
use crate::auth::service::normalize_wallet_address;
use crate::chat::service::{self as chat_service};
use crate::pages::chat::chat_actor::{ChatWs, PushEvent};

impl ChatWs {
    pub(crate) fn on_join(
        &mut self,
        request_id: Option<String>,
        nickname: String,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        if normalize_wallet_address(&self.sender_id).is_err() {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                request_id.as_deref(),
                "PAYMENT_REQUIRED",
                "Authenticated wallet with active paid access is required.",
            );
            return;
        }

        let now_unix = Utc::now().timestamp();
        let conn = match self.app_ctx.pool.get() {
            Ok(c) => c,
            Err(err) => {
                warn!(
                    "event=chat_error room_id={} sender_id={} code=INTERNAL request_id={} error={:?}",
                    self.room_id,
                    self.sender_id,
                    request_id.as_deref().unwrap_or("null"),
                    err
                );
                Self::send_error(
                    &self.room_id,
                    &self.sender_id,
                    ctx,
                    request_id.as_deref(),
                    "INTERNAL",
                    "Failed to acquire DB connection.",
                );
                return;
            }
        };

        let profile = match get_wallet_profile(&conn, &self.sender_id, now_unix) {
            Ok(p) => p,
            Err(err) => {
                Self::send_error(
                    &self.room_id,
                    &self.sender_id,
                    ctx,
                    request_id.as_deref(),
                    err.code(),
                    err.message(),
                );
                return;
            }
        };

        if !profile.has_active_access {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                request_id.as_deref(),
                "PAYMENT_REQUIRED",
                "Active paid access is required to join the room.",
            );
            return;
        }

        let candidate_nickname = if !nickname.trim().is_empty() {
            nickname.trim().to_string()
        } else if let Some(existing) = profile.nickname {
            existing
        } else {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                request_id.as_deref(),
                "VALIDATION_ERROR",
                "Nickname must be between 1 and 32 lowercase ASCII characters.",
            );
            return;
        };

        let updated_profile =
            match set_wallet_nickname(&conn, &self.sender_id, &candidate_nickname, now_unix) {
                Ok(p) => p,
                Err(err) => {
                    Self::send_error(
                        &self.room_id,
                        &self.sender_id,
                        ctx,
                        request_id.as_deref(),
                        err.code(),
                        err.message(),
                    );
                    return;
                }
            };
        drop(conn);

        let valid_nickname = updated_profile.nickname.unwrap_or(candidate_nickname);
        self.session.set_nickname(valid_nickname.clone());
        let room_id = self.room_id.clone();
        let sender_id = self.sender_id.clone();
        let app_ctx = self.app_ctx.clone();
        let addr = ctx.address();
        actix_web::rt::spawn(async move {
            let history_items = match chat_service::join_room_and_get_history(&app_ctx, &room_id)
                .await
            {
                Ok(items) => items,
                Err(err) => {
                    warn!(
                        "event=chat_error room_id={} sender_id={} code={} request_id={} error={:?} details={:?}",
                        room_id,
                        sender_id,
                        err.code(),
                        request_id.as_deref().unwrap_or("null"),
                        err,
                        err.details()
                    );
                    addr.do_send(PushEvent(chat_service::error_payload_from_error(
                        request_id.as_deref(),
                        &err,
                    )));
                    return;
                }
            };
            info!(
                "event=chat_join room_id={} sender_id={} nickname={}",
                room_id, sender_id, valid_nickname
            );
            addr.do_send(PushEvent(chat_service::joined_payload(
                request_id.clone(),
                &sender_id,
                &valid_nickname,
            )));
            addr.do_send(PushEvent(chat_service::history_payload(&history_items)));
        });
    }

    pub(crate) fn on_message(
        &mut self,
        request_id: Option<String>,
        body: String,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        let Some(sender_name) = self.session.sender_name() else {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                request_id.as_deref(),
                "VALIDATION_ERROR",
                "Join the room before sending messages.",
            );
            return;
        };
        if self.session.is_rate_limited() {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                request_id.as_deref(),
                "RATE_LIMITED",
                "Rate limit exceeded. Try again shortly.",
            );
            return;
        }
        let room_id = self.room_id.clone();
        let sender_id = self.sender_id.clone();
        let app_ctx = self.app_ctx.clone();
        let addr = ctx.address();
        actix_web::rt::spawn(async move {
            match chat_service::persist_message(&app_ctx, &room_id, &sender_id, &sender_name, &body)
                .await
            {
                Ok(item) => {
                    info!(
                        "event=chat_message room_id={} sender_id={} body_len={}",
                        room_id,
                        sender_id,
                        item.body.chars().count()
                    );
                    ChatWs::broadcast_to_room(
                        &room_id,
                        chat_service::message_payload(&item, request_id.as_deref()),
                    );
                }
                Err(err) => {
                    warn!(
                        "event=chat_error room_id={} sender_id={} code={} request_id={} error={:?} details={:?}",
                        room_id,
                        sender_id,
                        err.code(),
                        request_id.as_deref().unwrap_or("null"),
                        err,
                        err.details()
                    );
                    addr.do_send(PushEvent(chat_service::error_payload_from_error(
                        request_id.as_deref(),
                        &err,
                    )));
                }
            }
        });
    }

    pub(crate) fn on_delete(
        &mut self,
        request_id: Option<String>,
        message_id: i64,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        let room_id = self.room_id.clone();
        let sender_id = self.sender_id.clone();
        let app_ctx = self.app_ctx.clone();
        let addr = ctx.address();
        actix_web::rt::spawn(async move {
            match chat_service::delete_message(&app_ctx, &room_id, message_id, &sender_id).await {
                Ok(true) => {
                    info!(
                        "event=chat_delete room_id={} sender_id={} message_id={}",
                        room_id, sender_id, message_id
                    );
                    ChatWs::broadcast_to_room(&room_id, chat_service::deleted_payload(message_id));
                }
                Ok(false) => {
                    warn!(
                        "event=chat_error room_id={} sender_id={} code=VALIDATION_ERROR request_id={}",
                        room_id,
                        sender_id,
                        request_id.as_deref().unwrap_or("null")
                    );
                    addr.do_send(PushEvent(chat_service::error_payload(
                        request_id.as_deref(),
                        "VALIDATION_ERROR",
                        "Message not found.",
                    )));
                }
                Err(err) => {
                    warn!(
                        "event=chat_error room_id={} sender_id={} code={} request_id={} error={:?} details={:?}",
                        room_id,
                        sender_id,
                        err.code(),
                        request_id.as_deref().unwrap_or("null"),
                        err,
                        err.details()
                    );
                    addr.do_send(PushEvent(chat_service::error_payload_from_error(
                        request_id.as_deref(),
                        &err,
                    )));
                }
            }
        });
    }
}
