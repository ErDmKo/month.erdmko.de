use actix::{Actor, Addr};
use actix_web::web;
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use crate::app::AppCtx;
use super::error::{ChatError, ChatResult};
use super::db::{self, ChatMessage};

pub const MAX_MESSAGE_LEN: usize = 200;
pub const MAX_NICKNAME_LEN: usize = 32;
pub const HISTORY_LIMIT: usize = 50;
pub const WS_MAX_PAYLOAD_BYTES: usize = 4 * 1024;
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

    pub fn try_register_connection(&self, room_id: &str, addr: Addr<A>, max_connections: usize) -> bool {
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

#[derive(Deserialize)]
#[serde(tag = "type")]
pub enum ClientEvent {
    #[serde(rename = "join")]
    Join {
        #[serde(rename = "requestId")]
        request_id: Option<String>,
        nickname: String,
    },
    #[serde(rename = "message")]
    Message {
        #[serde(rename = "requestId")]
        request_id: Option<String>,
        body: String,
    },
    #[serde(rename = "delete")]
    Delete {
        #[serde(rename = "requestId")]
        request_id: Option<String>,
        #[serde(rename = "messageId")]
        message_id: i64,
    },
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

pub fn is_valid_text_payload_size(payload_len: usize) -> bool {
    payload_len <= WS_MAX_PAYLOAD_BYTES
}

pub fn parse_client_event(text: &str) -> ChatResult<ClientEvent> {
    serde_json::from_str(text)
        .map_err(|err| ChatError::bad_payload(format!("Malformed JSON payload: {err}")))
}

pub fn error_payload(request_id: Option<&str>, code: &str, message: &str) -> String {
    json!({
        "type": "error",
        "requestId": request_id,
        "code": code,
        "message": message,
        "ts": now_iso(),
    })
    .to_string()
}

pub fn error_payload_from_error(request_id: Option<&str>, err: &ChatError) -> String {
    error_payload(request_id, err.code(), err.message())
}

pub fn joined_payload(request_id: Option<String>, sender_id: &str, sender_name: &str) -> String {
    json!({
        "type": "joined",
        "requestId": request_id,
        "self": {
            "senderId": sender_id,
            "senderName": sender_name,
        },
        "ts": now_iso(),
    })
    .to_string()
}

pub fn history_payload(items: &[ChatMessage]) -> String {
    let history_items: Vec<_> = items
        .iter()
        .map(|item| {
            json!({
                "id": item.id,
                "roomId": item.room_id,
                "senderId": item.sender_id,
                "senderName": item.sender_name,
                "body": item.body,
                "createdAt": item.created_at,
            })
        })
        .collect();
    json!({
        "type": "history",
        "items": history_items,
        "ts": now_iso(),
    })
    .to_string()
}

pub fn message_payload(item: &ChatMessage) -> String {
    json!({
        "type": "message",
        "item": {
            "id": item.id,
            "roomId": item.room_id,
            "senderId": item.sender_id,
            "senderName": item.sender_name,
            "body": item.body,
            "createdAt": item.created_at,
        },
        "ts": now_iso(),
    })
    .to_string()
}

pub fn deleted_payload(message_id: i64) -> String {
    json!({
        "type": "deleted",
        "messageId": message_id,
        "ts": now_iso(),
    })
    .to_string()
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
