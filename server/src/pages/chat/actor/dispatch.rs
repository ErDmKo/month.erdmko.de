use actix_web_actors::ws;
use log::warn;

use crate::attachments::service::decode_upload_chunk;
use crate::chat::service::{self as chat_service, ClientEvent::*};

use super::ChatWs;

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
