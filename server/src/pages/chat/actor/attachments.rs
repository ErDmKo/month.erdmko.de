use actix::AsyncContext;
use actix_web_actors::ws;
use log::{info, warn};

use crate::attachments::service::{persist_upload, upload_done_payload};
use crate::chat::service::{self as chat_service};

use super::{ChatWs, PushEvent};

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
            warn!(
                "event=attachment_error code=UPLOAD_TOO_LARGE sender_id={} request_id={} size={}",
                self.sender_id,
                request_id.as_deref().unwrap_or("null"),
                size,
            );
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
            .start_upload(message_id, filename.clone(), size, mime_type.clone())
        {
            Ok(upload_id) => {
                info!(
                    "event=attachment_upload_start upload_id={} message_id={} filename={:?} size={} mime_type={:?} sender_id={}",
                    upload_id, message_id, filename, size, mime_type, self.sender_id,
                );
                ctx.binary(upload_ready_payload(request_id.as_deref(), upload_id));
            }
            Err(code) => {
                warn!(
                    "event=attachment_error code={} sender_id={} request_id={}",
                    code,
                    self.sender_id,
                    request_id.as_deref().unwrap_or("null"),
                );
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
                                "event=attachment_upload_done attachment_id={} sender_id={} room_id={}",
                                meta.id, sender_id, room_id,
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
                warn!(
                    "event=attachment_error code={} sender_id={} upload_id={} request_id={}",
                    code,
                    self.sender_id,
                    upload_id,
                    request_id.as_deref().unwrap_or("null"),
                );
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
                    info!(
                        "event=attachment_download_start attachment_id={} sender_id={} total_chunks={}",
                        attachment_id, sender_id, total,
                    );
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
                    info!(
                        "event=attachment_download_done attachment_id={} sender_id={}",
                        attachment_id, sender_id,
                    );
                }
                Ok(None) => {
                    warn!(
                        "event=attachment_error code=ATTACHMENT_NOT_FOUND attachment_id={} sender_id={} request_id={}",
                        attachment_id,
                        sender_id,
                        request_id.as_deref().unwrap_or("null"),
                    );
                    addr.do_send(PushEvent(chat_service::error_payload(
                        request_id.as_deref(),
                        "ATTACHMENT_NOT_FOUND",
                        "Attachment not found.",
                    )));
                }
                Err(err) => {
                    warn!(
                        "event=attachment_error code=INTERNAL attachment_id={} sender_id={} request_id={} error={:?}",
                        attachment_id,
                        sender_id,
                        request_id.as_deref().unwrap_or("null"),
                        err,
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
