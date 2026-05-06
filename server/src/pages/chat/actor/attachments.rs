use actix::AsyncContext;
use actix_web_actors::ws;
use log::{info, warn};

use crate::attachments::service::{decode_upload_chunk, persist_upload, upload_done_payload};
use crate::chat::service::{self as chat_service};

use super::{ChatWs, PushEvent};

// ── Text / binary frame entry points ─────────────────────────────────────────

impl ChatWs {
    pub(super) fn on_text(&mut self, text: &str, ctx: &mut ws::WebsocketContext<Self>) {
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
        let event = match chat_service::parse_client_event(text) {
            Ok(e) => e,
            Err(err) => {
                warn!(
                    "event=chat_error room_id={} sender_id={} code={} request_id=null error={:?} details={:?}",
                    self.room_id, self.sender_id, err.code(), err, err.details()
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

        use crate::chat::service::ClientEvent::*;
        match event {
            Join { request_id, nickname } => self.on_join(request_id, nickname, ctx),
            Message { request_id, body } => self.on_message(request_id, body, ctx),
            Delete { request_id, message_id } => self.on_delete(request_id, message_id, ctx),
            UploadStart { request_id, message_id, filename, size, mime_type } => {
                self.on_upload_start(request_id, message_id, filename, size, mime_type, ctx);
            }
            UploadEnd { request_id, upload_id } => self.on_upload_end(request_id, upload_id, ctx),
            DownloadRequest { request_id, attachment_id } => {
                self.on_download_request(request_id, attachment_id, ctx);
            }
        }
    }

    pub(super) fn on_binary(&mut self, bytes: &[u8], ctx: &mut ws::WebsocketContext<Self>) {
        match decode_upload_chunk(bytes) {
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
        }
    }
}

// ── Upload handlers ───────────────────────────────────────────────────────────

impl ChatWs {
    pub(super) fn on_upload_start(
        &mut self,
        request_id: Option<String>,
        message_id: i64,
        filename: String,
        size: usize,
        mime_type: String,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        use crate::attachments::MAX_ATTACHMENT_SIZE_BYTES;
        use crate::attachments::service::upload_ready_payload;

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
        match self.uploads.start_upload(message_id, filename, size, mime_type) {
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

    pub(super) fn on_upload_end(
        &mut self,
        request_id: Option<String>,
        upload_id: u32,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        match self.uploads.finish_upload(upload_id) {
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
                                upload_done_payload(request_id.as_deref(), upload_id, &meta),
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
        }
    }
}

// ── Download handler ──────────────────────────────────────────────────────────

impl ChatWs {
    pub(super) fn on_download_request(
        &mut self,
        request_id: Option<String>,
        attachment_id: i64,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        use crate::attachments::service::{
            download_end_payload, download_start_payload, encode_download_chunk,
            load_attachment_for_download, split_into_chunks,
        };

        let room_id = self.room_id.clone();
        let sender_id = self.sender_id.clone();
        let app_ctx = self.app_ctx.clone();
        let addr = ctx.address();
        actix_web::rt::spawn(async move {
            match load_attachment_for_download(&app_ctx, attachment_id, &room_id).await {
                Ok(Some((meta, data))) => {
                    let chunks = split_into_chunks(&data);
                    let total = chunks.len();
                    addr.do_send(PushEvent(download_start_payload(
                        request_id.as_deref(),
                        &meta,
                        total,
                    )));
                    for (i, chunk) in chunks.iter().enumerate() {
                        addr.do_send(super::PushBinary(encode_download_chunk(
                            attachment_id,
                            i as u32,
                            chunk,
                        )));
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
