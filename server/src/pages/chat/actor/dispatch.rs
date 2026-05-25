use actix_web_actors::ws;
use log::warn;

use crate::chat::service::{self as chat_service, ClientEvent::*};

use super::ChatWs;

impl ChatWs {
    pub(super) fn on_binary(&mut self, bytes: &[u8], ctx: &mut ws::WebsocketContext<Self>) {
        if bytes.is_empty() {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                None,
                "BAD_PAYLOAD",
                "Empty frame.",
            );
            return;
        }
        if !chat_service::is_valid_binary_payload_size(bytes.len()) {
            Self::send_error(
                &self.room_id,
                &self.sender_id,
                ctx,
                None,
                "BAD_PAYLOAD",
                "Payload exceeds limit.",
            );
            return;
        }

        // All frames are ClientFrame (oneof wrapper — no prefix byte needed)
        let event = match chat_service::parse_client_event(bytes) {
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
                // Send error back to client but keep connection alive — per spec.
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
            Join {
                request_id,
                nickname,
            } => self.on_join(request_id, nickname, ctx),
            Message { request_id, body } => self.on_message(request_id, body, ctx),
            Delete {
                request_id,
                message_id,
            } => self.on_delete(request_id, message_id, ctx),
            UploadStart {
                request_id,
                message_id,
                filename,
                size,
                mime_type,
            } => {
                self.on_upload_start(request_id, message_id, filename, size, mime_type, ctx);
            }
            UploadEnd {
                request_id,
                upload_id,
            } => self.on_upload_end(request_id, upload_id, ctx),
            DownloadRequest {
                request_id,
                attachment_id,
            } => {
                self.on_download_request(request_id, attachment_id, ctx);
            }
            UploadChunk {
                upload_id,
                index,
                data,
            } => {
                if let Err(code) = self.uploads.add_chunk(upload_id, index, data) {
                    warn!(
                        "event=attachment_error code={} sender_id={} upload_id={}",
                        code, self.sender_id, upload_id,
                    );
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
        }
    }
}
