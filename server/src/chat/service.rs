use actix::{Actor, Addr};
use actix_web::web;
use chrono::Utc;
use prost::Message;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use super::db::{self, ChatMessage};
use super::error::{ChatError, ChatResult};
use crate::app::AppCtx;
use crate::generated::chat::{
    AttachmentItem, ChatItem, ClientFrame, DownloadChunk, ServerDeleted, ServerDownloadEnd,
    ServerDownloadStart, ServerError, ServerFrame, ServerHistory, ServerJoined, ServerMessage,
    ServerUploadDone, ServerUploadReady, client_frame, server_frame,
};

pub const MAX_MESSAGE_LEN: usize = 200;
pub const MAX_NICKNAME_LEN: usize = 32;
pub const HISTORY_LIMIT: usize = 50;
pub const WS_MAX_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_MESSAGES_STORAGE_BYTES: usize = 100 * 1024 * 1024;
pub const MAX_ROOMS_STORAGE_BYTES: usize = 1024 * 1024;
pub const WS_FRAME_MAX_BYTES: usize = 64 * 1024;
pub const MAX_OPEN_CONNECTIONS: usize = 100;
pub const RATE_LIMIT_MAX_MESSAGES: usize = 5;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(10);

pub struct RoomRegistry<A: Actor> {
    rooms: Arc<RwLock<HashMap<String, Vec<Addr<A>>>>>,
}

impl<A: Actor> RoomRegistry<A> {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn try_register_connection(
        &self,
        room_id: &str,
        addr: Addr<A>,
        max_connections: usize,
    ) -> bool {
        let mut rooms = self
            .rooms
            .write()
            .expect("chat rooms lock should be available");
        let total_connections: usize = rooms.values().map(Vec::len).sum();
        if total_connections >= max_connections {
            return false;
        }
        let room = rooms.entry(room_id.to_string()).or_default();
        room.retain(Addr::connected);
        room.push(addr);
        true
    }

    pub fn cleanup_room(&self, room_id: &str) {
        let mut rooms = self
            .rooms
            .write()
            .expect("chat rooms lock should be available");
        if let Some(addresses) = rooms.get_mut(room_id) {
            addresses.retain(Addr::connected);
            if addresses.is_empty() {
                rooms.remove(room_id);
            }
        }
    }

    pub fn connected_recipients(&self, room_id: &str) -> Vec<Addr<A>> {
        let mut rooms = self
            .rooms
            .write()
            .expect("chat rooms lock should be available");
        let Some(addresses) = rooms.get_mut(room_id) else {
            return Vec::new();
        };
        addresses.retain(Addr::connected);
        addresses.clone()
    }
}

// ── Incoming client event (parsed from ClientFrame protobuf) ──────────────────

pub enum ClientEvent {
    Join {
        request_id: Option<String>,
        nickname: String,
    },
    Message {
        request_id: Option<String>,
        body: String,
    },
    Delete {
        request_id: Option<String>,
        message_id: i64,
    },
    UploadStart {
        request_id: Option<String>,
        message_id: i64,
        filename: String,
        size: usize,
        mime_type: String,
    },
    UploadEnd {
        request_id: Option<String>,
        upload_id: u32,
    },
    DownloadRequest {
        request_id: Option<String>,
        attachment_id: i64,
    },
    UploadChunk {
        upload_id: u32,
        index: u32,
        data: Vec<u8>,
    },
}

pub fn parse_client_event(buf: &[u8]) -> ChatResult<ClientEvent> {
    let frame =
        ClientFrame::decode(buf).map_err(|_| ChatError::bad_payload("Malformed client frame."))?;

    match frame.payload {
        Some(client_frame::Payload::Join(msg)) => Ok(ClientEvent::Join {
            request_id: opt_string(msg.request_id),
            nickname: msg.nickname,
        }),
        Some(client_frame::Payload::Message(msg)) => Ok(ClientEvent::Message {
            request_id: opt_string(msg.request_id),
            body: msg.body,
        }),
        Some(client_frame::Payload::Delete(msg)) => Ok(ClientEvent::Delete {
            request_id: opt_string(msg.request_id),
            message_id: msg.message_id,
        }),
        Some(client_frame::Payload::UploadStart(msg)) => Ok(ClientEvent::UploadStart {
            request_id: opt_string(msg.request_id),
            message_id: msg.message_id,
            filename: msg.filename,
            size: msg.size as usize,
            mime_type: msg.mime_type,
        }),
        Some(client_frame::Payload::UploadEnd(msg)) => Ok(ClientEvent::UploadEnd {
            request_id: opt_string(msg.request_id),
            upload_id: msg.upload_id,
        }),
        Some(client_frame::Payload::DownloadRequest(msg)) => Ok(ClientEvent::DownloadRequest {
            request_id: opt_string(msg.request_id),
            attachment_id: msg.attachment_id,
        }),
        Some(client_frame::Payload::UploadChunk(msg)) => Ok(ClientEvent::UploadChunk {
            upload_id: msg.upload_id,
            index: msg.index,
            data: msg.data,
        }),
        None => Err(ChatError::bad_payload("Empty client frame.")),
    }
}

fn opt_string(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

pub struct ChatSessionState {
    nickname: Option<String>,
    message_timestamps: VecDeque<Instant>,
}

impl ChatSessionState {
    pub fn new() -> Self {
        Self {
            nickname: None,
            message_timestamps: VecDeque::new(),
        }
    }

    pub fn validate_nickname(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        let len = trimmed.chars().count();
        if len == 0 || len > MAX_NICKNAME_LEN {
            return None;
        }
        Some(trimmed.to_string())
    }

    pub fn set_nickname(&mut self, nickname: String) {
        self.nickname = Some(nickname);
    }

    pub fn sender_name(&self) -> Option<String> {
        self.nickname.clone()
    }

    pub fn is_rate_limited(&mut self) -> bool {
        let now = Instant::now();
        while let Some(oldest) = self.message_timestamps.front() {
            if now.duration_since(*oldest) > RATE_LIMIT_WINDOW {
                self.message_timestamps.pop_front();
            } else {
                break;
            }
        }
        if self.message_timestamps.len() >= RATE_LIMIT_MAX_MESSAGES {
            return true;
        }
        self.message_timestamps.push_back(now);
        false
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub fn is_valid_binary_payload_size(payload_len: usize) -> bool {
    payload_len <= WS_MAX_PAYLOAD_BYTES
}

pub fn is_allowed_origin(origin: &str) -> bool {
    let normalized = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    let host = normalized
        .strip_prefix("http://")
        .or_else(|| normalized.strip_prefix("https://"))
        .unwrap_or(normalized.as_str())
        .split('/')
        .next()
        .unwrap_or("");
    matches!(host, "erdmko.dev" | "erdmko.dev:443" | "localhost:8080")
}

// ── Server → Client payload builders ─────────────────────────────────────────
// Every builder wraps its payload in ServerFrame and encodes to Vec<u8>.

fn server_frame(payload: server_frame::Payload) -> Vec<u8> {
    ServerFrame {
        payload: Some(payload),
    }
    .encode_to_vec()
}

pub fn error_payload(request_id: Option<&str>, code: &str, message: &str) -> Vec<u8> {
    server_frame(server_frame::Payload::Error(ServerError {
        request_id: request_id.unwrap_or("").to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }))
}

pub fn error_payload_from_error(request_id: Option<&str>, err: &ChatError) -> Vec<u8> {
    error_payload(request_id, err.code(), err.message())
}

pub fn joined_payload(request_id: Option<String>, sender_id: &str, sender_name: &str) -> Vec<u8> {
    server_frame(server_frame::Payload::Joined(ServerJoined {
        request_id: request_id.unwrap_or_default(),
        sender_id: sender_id.to_string(),
        sender_name: sender_name.to_string(),
    }))
}

fn chat_item_proto(item: &ChatMessage) -> ChatItem {
    ChatItem {
        id: item.id,
        room_id: item.room_id.clone(),
        sender_id: item.sender_id.clone(),
        sender_name: item.sender_name.clone(),
        body: item.body.clone(),
        created_at: item.created_at.clone(),
        attachments: item
            .attachments
            .iter()
            .map(|a| AttachmentItem {
                id: a.id,
                filename: a.filename.clone(),
                size: a.size,
                mime_type: a.mime_type.clone(),
            })
            .collect(),
    }
}

pub fn history_payload(items: &[ChatMessage]) -> Vec<u8> {
    let proto_items: Vec<ChatItem> = items.iter().map(chat_item_proto).collect();
    server_frame(server_frame::Payload::History(ServerHistory {
        items: proto_items,
    }))
}

pub fn message_payload(item: &ChatMessage, request_id: Option<&str>) -> Vec<u8> {
    server_frame(server_frame::Payload::Message(ServerMessage {
        item: Some(chat_item_proto(item)),
        request_id: request_id.unwrap_or("").to_string(),
    }))
}

pub fn deleted_payload(message_id: i64) -> Vec<u8> {
    server_frame(server_frame::Payload::Deleted(ServerDeleted { message_id }))
}

pub fn upload_ready_payload(request_id: Option<&str>, upload_id: u32) -> Vec<u8> {
    server_frame(server_frame::Payload::UploadReady(ServerUploadReady {
        request_id: request_id.unwrap_or("").to_string(),
        upload_id,
    }))
}

pub fn upload_done_payload(
    request_id: Option<&str>,
    attachment_id: i64,
    filename: &str,
    size: i64,
    mime_type: &str,
    message_id: i64,
) -> Vec<u8> {
    server_frame(server_frame::Payload::UploadDone(ServerUploadDone {
        request_id: request_id.unwrap_or("").to_string(),
        attachment_id,
        filename: filename.to_string(),
        size,
        mime_type: mime_type.to_string(),
        message_id,
    }))
}

pub fn download_start_payload(
    request_id: Option<&str>,
    attachment_id: i64,
    filename: &str,
    size: i64,
    mime_type: &str,
    total_chunks: u32,
) -> Vec<u8> {
    server_frame(server_frame::Payload::DownloadStart(ServerDownloadStart {
        request_id: request_id.unwrap_or("").to_string(),
        attachment_id,
        filename: filename.to_string(),
        size,
        mime_type: mime_type.to_string(),
        total_chunks,
    }))
}

pub fn download_end_payload(request_id: Option<&str>, attachment_id: i64) -> Vec<u8> {
    server_frame(server_frame::Payload::DownloadEnd(ServerDownloadEnd {
        request_id: request_id.unwrap_or("").to_string(),
        attachment_id,
    }))
}

pub fn download_chunk_payload(attachment_id: i64, index: u32, data: Vec<u8>) -> Vec<u8> {
    server_frame(server_frame::Payload::DownloadChunk(DownloadChunk {
        attachment_id,
        index,
        data,
    }))
}

pub async fn join_room_and_get_history(
    app_ctx: &web::Data<AppCtx>,
    room_id: &str,
) -> ChatResult<Vec<ChatMessage>> {
    db::create_room_if_not_exists(app_ctx, room_id).await?;
    db::get_recent_messages(app_ctx, room_id, None).await
}

pub async fn persist_message(
    app_ctx: &web::Data<AppCtx>,
    room_id: &str,
    sender_id: &str,
    sender_name: &str,
    body: &str,
) -> ChatResult<ChatMessage> {
    db::insert_message(app_ctx, room_id, sender_id, sender_name, body).await
}

pub async fn delete_message(
    app_ctx: &web::Data<AppCtx>,
    room_id: &str,
    message_id: i64,
) -> ChatResult<bool> {
    db::delete_message_by_id(app_ctx, room_id, message_id).await
}
