use actix::{Actor, Addr, AsyncContext, Handler, Message, StreamHandler};
use actix_web::web;
use actix_web_actors::ws;
use log::{info, warn};
use std::sync::LazyLock;

use crate::app::AppCtx;
use crate::attachments::MAX_ATTACHMENT_SIZE_BYTES;
use crate::attachments::service::{
    UploadSessionState, decode_upload_chunk, download_end_payload, download_start_payload,
    encode_download_chunk, load_attachment_for_download, persist_upload, split_into_chunks,
    upload_done_payload, upload_ready_payload,
};
use crate::chat::service::{self as chat_service, ChatSessionState, ClientEvent, RoomRegistry};

pub(super) static CHAT_ROOMS: LazyLock<RoomRegistry<ChatWs>> = LazyLock::new(RoomRegistry::new);

#[derive(Message)]
#[rtype(result = "()")]
pub(super) struct PushEvent(pub(super) String);

#[derive(Message)]
#[rtype(result = "()")]
pub(super) struct PushBinary(pub(super) Vec<u8>);

pub(super) struct ChatWs {
    pub(super) app_ctx: web::Data<AppCtx>,
    pub(super) room_id: String,
    pub(super) sender_id: String,
    pub(super) session: ChatSessionState,
    pub(super) is_registered: bool,
    pub(super) uploads: UploadSessionState,
}

impl ChatWs {
    fn send_error(
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
        ctx.text(chat_service::error_payload(request_id, code, message));
    }

    fn register_connection(room_id: &str, addr: Addr<Self>) -> bool {
        CHAT_ROOMS.try_register_connection(room_id, addr, chat_service::MAX_OPEN_CONNECTIONS)
    }

    fn cleanup_room(room_id: &str) {
        CHAT_ROOMS.cleanup_room(room_id);
    }

    fn broadcast_to_room(room_id: &str, payload: String) {
        let recipients: Vec<Addr<Self>> = CHAT_ROOMS.connected_recipients(room_id);
        for addr in recipients {
            addr.do_send(PushEvent(payload.clone()));
        }
    }
}

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
        ctx.text(chat_service::error_payload(
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
        info!(
            "event=chat_disconnect room_id={} sender_id={}",
            self.room_id, self.sender_id
        );
    }
}

impl Handler<PushEvent> for ChatWs {
    type Result = ();

    fn handle(&mut self, msg: PushEvent, ctx: &mut Self::Context) -> Self::Result {
        ctx.text(msg.0);
    }
}

impl Handler<PushBinary> for ChatWs {
    type Result = ();

    fn handle(&mut self, msg: PushBinary, ctx: &mut Self::Context) -> Self::Result {
        ctx.binary(msg.0);
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for ChatWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Text(text)) => {
                if !chat_service::is_valid_text_payload_size(text.len()) {
                    Self::send_error(
                        &self.room_id,
                        &self.sender_id,
                        ctx,
                        None,
                        "BAD_PAYLOAD",
                        "Payload exceeds 4KB limit.",
                    );
                    return;
                }
                let event: ClientEvent = match chat_service::parse_client_event(&text) {
                    Ok(e) => e,
                    Err(err) => {
                        warn!(
                            "event=chat_error room_id={} sender_id={} code={} request_id=null error={:?} details={:?}",
                            self.room_id,
                            self.sender_id,
                            err.code(),
                            err,
                            err.details()
                        );
                        Self::send_error(
                            &self.room_id,
                            &self.sender_id,
                            ctx,
                            None,
                            err.code(),
                            err.message(),
                        );
                        return;
                    }
                };

                match event {
                    ClientEvent::Join {
                        request_id,
                        nickname,
                    } => {
                        let Some(valid_nickname) = ChatSessionState::validate_nickname(&nickname)
                        else {
                            Self::send_error(
                                &self.room_id,
                                &self.sender_id,
                                ctx,
                                request_id.as_deref(),
                                "VALIDATION_ERROR",
                                "Nickname must be between 1 and 32 characters.",
                            );
                            return;
                        };

                        self.session.set_nickname(valid_nickname.clone());
                        let room_id = self.room_id.clone();
                        let sender_id = self.sender_id.clone();
                        let app_ctx = self.app_ctx.clone();
                        let addr = ctx.address();
                        actix_web::rt::spawn(async move {
                            let history_items = match chat_service::join_room_and_get_history(
                                &app_ctx, &room_id,
                            )
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
                                    addr.do_send(PushEvent(
                                        chat_service::error_payload_from_error(
                                            request_id.as_deref(),
                                            &err,
                                        ),
                                    ));
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
                    ClientEvent::Message { request_id, body } => {
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
                            match chat_service::persist_message(
                                &app_ctx,
                                &room_id,
                                &sender_id,
                                &sender_name,
                                &body,
                            )
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
                                        chat_service::message_payload(&item),
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
                                    addr.do_send(PushEvent(
                                        chat_service::error_payload_from_error(
                                            request_id.as_deref(),
                                            &err,
                                        ),
                                    ));
                                }
                            }
                        });
                    }
                    ClientEvent::Delete {
                        request_id,
                        message_id,
                    } => {
                        let room_id = self.room_id.clone();
                        let sender_id = self.sender_id.clone();
                        let app_ctx = self.app_ctx.clone();
                        let addr = ctx.address();
                        actix_web::rt::spawn(async move {
                            match chat_service::delete_message(&app_ctx, &room_id, message_id).await
                            {
                                Ok(true) => {
                                    info!(
                                        "event=chat_delete room_id={} sender_id={} message_id={}",
                                        room_id, sender_id, message_id
                                    );
                                    ChatWs::broadcast_to_room(
                                        &room_id,
                                        chat_service::deleted_payload(message_id),
                                    );
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
                                    addr.do_send(PushEvent(
                                        chat_service::error_payload_from_error(
                                            request_id.as_deref(),
                                            &err,
                                        ),
                                    ));
                                }
                            }
                        });
                    }
                    ClientEvent::UploadStart {
                        request_id,
                        message_id,
                        filename,
                        size,
                        mime_type,
                    } => {
                        if size == 0 || size > MAX_ATTACHMENT_SIZE_BYTES {
                            Self::send_error(
                                &self.room_id,
                                &self.sender_id,
                                ctx,
                                request_id.as_deref(),
                                "UPLOAD_TOO_LARGE",
                                "File size must be between 1 byte and 5 MB.",
                            );
                            return;
                        }
                        match self
                            .uploads
                            .start_upload(message_id, filename, size, mime_type)
                        {
                            Ok(upload_id) => {
                                ctx.text(upload_ready_payload(request_id.as_deref(), upload_id));
                            }
                            Err(code) => {
                                Self::send_error(
                                    &self.room_id,
                                    &self.sender_id,
                                    ctx,
                                    request_id.as_deref(),
                                    code,
                                    "Upload limit reached. Complete or wait for existing uploads.",
                                );
                            }
                        }
                    }
                    ClientEvent::UploadEnd {
                        request_id,
                        upload_id,
                    } => match self.uploads.finish_upload(upload_id) {
                        Ok(pending) => {
                            let room_id = self.room_id.clone();
                            let sender_id = self.sender_id.clone();
                            let app_ctx = self.app_ctx.clone();
                            let addr = ctx.address();
                            actix_web::rt::spawn(async move {
                                match persist_upload(&app_ctx, pending).await {
                                    Ok(meta) => {
                                        info!(
                                            "event=upload_done room_id={} sender_id={} attachment_id={}",
                                            room_id, sender_id, meta.id
                                        );
                                        ChatWs::broadcast_to_room(
                                            &room_id,
                                            upload_done_payload(
                                                request_id.as_deref(),
                                                upload_id,
                                                &meta,
                                            ),
                                        );
                                    }
                                    Err(err) => {
                                        warn!(
                                            "event=chat_error room_id={} sender_id={} code=INTERNAL error={:?}",
                                            room_id, sender_id, err
                                        );
                                        addr.do_send(PushEvent(chat_service::error_payload(
                                            request_id.as_deref(),
                                            "INTERNAL",
                                            "Failed to persist attachment.",
                                        )));
                                    }
                                }
                            });
                        }
                        Err(code) => {
                            Self::send_error(
                                &self.room_id,
                                &self.sender_id,
                                ctx,
                                request_id.as_deref(),
                                code,
                                "Upload could not be completed.",
                            );
                        }
                    },
                    ClientEvent::DownloadRequest {
                        request_id,
                        attachment_id,
                    } => {
                        let room_id = self.room_id.clone();
                        let sender_id = self.sender_id.clone();
                        let app_ctx = self.app_ctx.clone();
                        let addr = ctx.address();
                        actix_web::rt::spawn(async move {
                            match load_attachment_for_download(&app_ctx, attachment_id, &room_id)
                                .await
                            {
                                Ok(Some((meta, data))) => {
                                    let chunks = split_into_chunks(&data);
                                    let total = chunks.len();
                                    addr.do_send(PushEvent(download_start_payload(
                                        request_id.as_deref(),
                                        &meta,
                                        total,
                                    )));
                                    for (i, chunk) in chunks.iter().enumerate() {
                                        let frame =
                                            encode_download_chunk(attachment_id, i as u32, chunk);
                                        addr.do_send(PushBinary(frame));
                                    }
                                    addr.do_send(PushEvent(download_end_payload(
                                        request_id.as_deref(),
                                        attachment_id,
                                    )));
                                }
                                Ok(None) => {
                                    warn!(
                                        "event=chat_error room_id={} sender_id={} code=ATTACHMENT_NOT_FOUND",
                                        room_id, sender_id
                                    );
                                    addr.do_send(PushEvent(chat_service::error_payload(
                                        request_id.as_deref(),
                                        "ATTACHMENT_NOT_FOUND",
                                        "Attachment not found.",
                                    )));
                                }
                                Err(err) => {
                                    warn!(
                                        "event=chat_error room_id={} sender_id={} code=INTERNAL error={:?}",
                                        room_id, sender_id, err
                                    );
                                    addr.do_send(PushEvent(chat_service::error_payload(
                                        request_id.as_deref(),
                                        "INTERNAL",
                                        "Failed to load attachment.",
                                    )));
                                }
                            }
                        });
                    }
                }
            }
            Ok(ws::Message::Binary(bytes)) => match decode_upload_chunk(&bytes) {
                Some((upload_id, index, data)) => {
                    if let Err(code) = self.uploads.add_chunk(upload_id, index, data) {
                        Self::send_error(
                            &self.room_id,
                            &self.sender_id,
                            ctx,
                            None,
                            code,
                            "Chunk rejected.",
                        );
                    }
                }
                None => {
                    Self::send_error(
                        &self.room_id,
                        &self.sender_id,
                        ctx,
                        None,
                        "BAD_PAYLOAD",
                        "Invalid binary frame.",
                    );
                }
            },
            Ok(ws::Message::Close(reason)) => ctx.close(reason),
            _ => {}
        }
    }
}
