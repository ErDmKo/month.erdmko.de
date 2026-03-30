use actix::{Actor, Addr, AsyncContext, Handler, Message, StreamHandler};
use actix_web::{get, web, Error, HttpRequest, HttpResponse, Result};
use actix_web_actors::ws;
use chrono::Utc;
use rand::random;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

use crate::app::AppCtx;
use crate::chat::{MAX_NICKNAME_LEN, WS_MAX_PAYLOAD_BYTES};
use crate::db;

type RoomsMap = Arc<RwLock<HashMap<String, Vec<Addr<ChatWs>>>>>;
static CHAT_ROOMS: LazyLock<RoomsMap> = LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));

#[derive(Message)]
#[rtype(result = "()")]
struct PushEvent(String);

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientEvent {
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
}

struct ChatWs {
    app_ctx: web::Data<AppCtx>,
    room_id: String,
    sender_id: String,
    nickname: Option<String>,
}

impl ChatWs {
    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    fn send_error(
        ctx: &mut ws::WebsocketContext<Self>,
        request_id: Option<&str>,
        code: &str,
        message: &str,
    ) {
        ctx.text(
            json!({
                "type": "error",
                "requestId": request_id,
                "code": code,
                "message": message,
                "ts": Self::now_iso(),
            })
            .to_string(),
        );
    }

    fn register_connection(room_id: &str, addr: Addr<Self>) {
        let mut rooms = CHAT_ROOMS
            .write()
            .expect("chat rooms lock should be available");
        let room = rooms.entry(room_id.to_string()).or_default();
        room.retain(Addr::connected);
        room.push(addr);
    }

    fn cleanup_room(room_id: &str) {
        let mut rooms = CHAT_ROOMS
            .write()
            .expect("chat rooms lock should be available");
        if let Some(addresses) = rooms.get_mut(room_id) {
            addresses.retain(Addr::connected);
            if addresses.is_empty() {
                rooms.remove(room_id);
            }
        }
    }

    fn broadcast_to_room(room_id: &str, payload: String) {
        let recipients: Vec<Addr<Self>> = {
            let mut rooms = CHAT_ROOMS
                .write()
                .expect("chat rooms lock should be available");
            let Some(addresses) = rooms.get_mut(room_id) else {
                return;
            };
            addresses.retain(Addr::connected);
            addresses.clone()
        };
        for addr in recipients {
            addr.do_send(PushEvent(payload.clone()));
        }
    }

    fn validate_nickname(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        let len = trimmed.chars().count();
        if len == 0 || len > MAX_NICKNAME_LEN {
            return None;
        }
        Some(trimmed.to_string())
    }
}

impl Actor for ChatWs {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        Self::register_connection(&self.room_id, ctx.address());
    }

    fn stopped(&mut self, _ctx: &mut Self::Context) {
        Self::cleanup_room(&self.room_id);
    }
}

impl Handler<PushEvent> for ChatWs {
    type Result = ();

    fn handle(&mut self, msg: PushEvent, ctx: &mut Self::Context) -> Self::Result {
        ctx.text(msg.0);
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for ChatWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Text(text)) => {
                let event: ClientEvent = match serde_json::from_str(&text) {
                    Ok(e) => e,
                    Err(_) => {
                        Self::send_error(ctx, None, "BAD_PAYLOAD", "Malformed JSON payload.");
                        return;
                    }
                };

                match event {
                    ClientEvent::Join {
                        request_id,
                        nickname,
                    } => {
                        let Some(valid_nickname) = Self::validate_nickname(&nickname) else {
                            Self::send_error(
                                ctx,
                                request_id.as_deref(),
                                "VALIDATION_ERROR",
                                "Nickname must be between 1 and 32 characters.",
                            );
                            return;
                        };

                        self.nickname = Some(valid_nickname.clone());
                        let room_id = self.room_id.clone();
                        let sender_id = self.sender_id.clone();
                        let app_ctx = self.app_ctx.clone();
                        let addr = ctx.address();
                        actix_web::rt::spawn(async move {
                            if db::create_room_if_not_exists(&app_ctx, &room_id).await.is_err() {
                                addr.do_send(PushEvent(
                                    json!({
                                        "type": "error",
                                        "requestId": request_id,
                                        "code": "INTERNAL_ERROR",
                                        "message": "Failed to join room.",
                                        "ts": ChatWs::now_iso(),
                                    })
                                    .to_string(),
                                ));
                                return;
                            }
                            let joined_payload = json!({
                                "type": "joined",
                                "requestId": request_id.clone(),
                                "self": {
                                    "senderId": sender_id,
                                    "senderName": valid_nickname,
                                },
                                "ts": ChatWs::now_iso(),
                            })
                            .to_string();
                            addr.do_send(PushEvent(joined_payload));

                            match db::get_recent_messages(&app_ctx, &room_id, None).await {
                                Ok(items) => {
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
                                    addr.do_send(PushEvent(
                                        json!({
                                            "type": "history",
                                            "items": history_items,
                                            "ts": ChatWs::now_iso(),
                                        })
                                        .to_string(),
                                    ));
                                }
                                Err(_) => {
                                    addr.do_send(PushEvent(
                                        json!({
                                            "type": "error",
                                            "requestId": request_id.clone(),
                                            "code": "INTERNAL_ERROR",
                                            "message": "Failed to load history.",
                                            "ts": ChatWs::now_iso(),
                                        })
                                        .to_string(),
                                    ));
                                }
                            }
                        });
                    }
                    ClientEvent::Message { request_id, body } => {
                        let Some(sender_name) = self.nickname.clone() else {
                            Self::send_error(
                                ctx,
                                request_id.as_deref(),
                                "VALIDATION_ERROR",
                                "Join the room before sending messages.",
                            );
                            return;
                        };

                        let room_id = self.room_id.clone();
                        let sender_id = self.sender_id.clone();
                        let app_ctx = self.app_ctx.clone();
                        let addr = ctx.address();
                        actix_web::rt::spawn(async move {
                            match db::insert_message(
                                &app_ctx,
                                &room_id,
                                &sender_id,
                                &sender_name,
                                &body,
                            )
                            .await
                            {
                                Ok(item) => {
                                    let payload = json!({
                                        "type": "message",
                                        "item": {
                                            "id": item.id,
                                            "roomId": item.room_id,
                                            "senderId": item.sender_id,
                                            "senderName": item.sender_name,
                                            "body": item.body,
                                            "createdAt": item.created_at,
                                        },
                                        "ts": ChatWs::now_iso(),
                                    })
                                    .to_string();
                                    ChatWs::broadcast_to_room(&room_id, payload);
                                }
                                Err(_) => {
                                    addr.do_send(PushEvent(
                                        json!({
                                            "type": "error",
                                            "requestId": request_id,
                                            "code": "VALIDATION_ERROR",
                                            "message": "Message must be between 1 and 200 characters.",
                                            "ts": ChatWs::now_iso(),
                                        })
                                        .to_string(),
                                    ));
                                }
                            }
                        });
                    }
                }
            }
            Ok(ws::Message::Binary(_)) => {
                Self::send_error(ctx, None, "BAD_PAYLOAD", "Binary payload is not supported.");
            }
            Ok(ws::Message::Close(reason)) => ctx.close(reason),
            _ => {}
        }
    }
}

#[get("/chat/{room_id}")]
pub async fn chat_room_page_handler(room_id: web::Path<String>) -> Result<HttpResponse> {
    Ok(HttpResponse::Ok().body(format!("Chat room stub: {}", room_id.into_inner())))
}

#[get("/ws/chat/{room_id}")]
pub async fn chat_ws_page_handler(
    req: HttpRequest,
    stream: web::Payload,
    room_id: web::Path<String>,
) -> Result<HttpResponse, Error> {
    let app_ctx = req
        .app_data::<web::Data<AppCtx>>()
        .cloned()
        .ok_or_else(|| actix_web::error::ErrorInternalServerError("app context is missing"))?;
    let room_id = room_id.into_inner();
    let sender_id = format!("anon-{:x}", random::<u64>());

    ws::WsResponseBuilder::new(
        ChatWs {
            app_ctx,
            room_id,
            sender_id,
            nickname: None,
        },
        &req,
        stream,
    )
        .frame_size(WS_MAX_PAYLOAD_BYTES)
        .start()
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{App, HttpServer};
    use futures_util::{SinkExt, Stream, StreamExt};
    use r2d2_sqlite::SqliteConnectionManager;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn setup_ctx() -> web::Data<AppCtx> {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("month_chat_ws_db_{unique_suffix}.sqlite"));

        let manager = SqliteConnectionManager::file(db_path);
        let pool = crate::app::Pool::new(manager).expect("pool should be created");
        let ctx = web::Data::new(AppCtx {
            static_path: PathBuf::new(),
            pool,
        });
        prepare_chat_schema(&ctx);
        ctx
    }

    fn prepare_chat_schema(ctx: &web::Data<AppCtx>) {
        let conn = ctx.pool.get().expect("pool connection should be available");
        conn.execute(
            format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id TEXT PRIMARY KEY,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )",
                db::CHAT_ROOMS_TABLE
            )
            .as_str(),
            (),
        )
        .expect("rooms table should be created");

        conn.execute(
            format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id TEXT NOT NULL,
                    sender_id TEXT NOT NULL,
                    sender_name TEXT NOT NULL,
                    body TEXT NOT NULL CHECK(length(body) <= {}),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )",
                db::CHAT_MESSAGES_TABLE,
                crate::chat::MAX_MESSAGE_LEN
            )
            .as_str(),
            (),
        )
        .expect("messages table should be created");

        conn.execute(
            format!(
                "CREATE INDEX IF NOT EXISTS idx_messages_room_created_at ON {}(room_id, created_at)",
                db::CHAT_MESSAGES_TABLE
            )
            .as_str(),
            (),
        )
        .expect("messages index should be created");
    }

    async fn read_next_text<S>(socket: &mut S) -> serde_json::Value
    where
        S: Stream<Item = Result<awc::ws::Frame, awc::error::WsProtocolError>> + Unpin,
    {
        loop {
            let frame = actix_web::rt::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .expect("frame timeout")
                .expect("socket should stay open")
                .expect("frame should be valid");
            if let awc::ws::Frame::Text(text) = frame {
                let payload = std::str::from_utf8(&text).expect("utf8 text frame");
                return serde_json::from_str(payload).expect("json payload");
            }
        }
    }

    #[actix_web::test]
    async fn join_sends_joined_and_history() {
        let ctx = setup_ctx();
        let room_id = format!("room-{}", random::<u64>());
        db::create_room_if_not_exists(&ctx, &room_id)
            .await
            .expect("room should be created");
        db::insert_message(&ctx, &room_id, "u1", "alice", "hello history")
            .await
            .expect("message should be inserted");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let addr = listener.local_addr().expect("listener local addr");
        let server_ctx = ctx.clone();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(server_ctx.clone())
                .service(chat_ws_page_handler)
        })
        .listen(listener)
        .expect("listen should succeed")
        .run();
        let handle = server.handle();
        actix_web::rt::spawn(server);

        let ws_url = format!("ws://{}/ws/chat/{}", addr, room_id);
        let (_resp, mut ws) = awc::Client::new()
            .ws(ws_url)
            .connect()
            .await
            .expect("ws connect should succeed");
        ws.send(awc::ws::Message::Text(
            json!({
                "type": "join",
                "requestId": "r1",
                "nickname": "dima"
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("join should be sent");

        let first = read_next_text(&mut ws).await;
        let second = read_next_text(&mut ws).await;
        let events = vec![first, second];
        assert!(events.iter().any(|e| e["type"] == "joined"));
        let history = events
            .iter()
            .find(|e| e["type"] == "history")
            .expect("history event should exist");
        assert!(
            history["items"]
                .as_array()
                .expect("history items should be array")
                .iter()
                .any(|item| item["body"] == "hello history")
        );

        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn message_broadcasts_only_inside_room() {
        let ctx = setup_ctx();
        let room_id = format!("room-{}", random::<u64>());
        let other_room = format!("room-{}", random::<u64>());

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let addr = listener.local_addr().expect("listener local addr");
        let server_ctx = ctx.clone();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(server_ctx.clone())
                .service(chat_ws_page_handler)
        })
        .listen(listener)
        .expect("listen should succeed")
        .run();
        let handle = server.handle();
        actix_web::rt::spawn(server);

        let ws_url_1 = format!("ws://{}/ws/chat/{}", addr, room_id);
        let ws_url_2 = format!("ws://{}/ws/chat/{}", addr, room_id);
        let ws_url_other = format!("ws://{}/ws/chat/{}", addr, other_room);
        let (_resp1, mut ws1) = awc::Client::new()
            .ws(ws_url_1)
            .connect()
            .await
            .expect("ws1 connect should succeed");
        let (_resp2, mut ws2) = awc::Client::new()
            .ws(ws_url_2)
            .connect()
            .await
            .expect("ws2 connect should succeed");
        let (_resp_other, mut ws_other) = awc::Client::new()
            .ws(ws_url_other)
            .connect()
            .await
            .expect("ws_other connect should succeed");

        ws1.send(awc::ws::Message::Text(
            json!({"type":"join","nickname":"alice"}).to_string().into(),
        ))
        .await
        .expect("join ws1");
        ws2.send(awc::ws::Message::Text(
            json!({"type":"join","nickname":"bob"}).to_string().into(),
        ))
        .await
        .expect("join ws2");
        ws_other
            .send(awc::ws::Message::Text(
                json!({"type":"join","nickname":"charlie"}).to_string().into(),
            ))
            .await
            .expect("join ws_other");

        let _ = read_next_text(&mut ws1).await;
        let _ = read_next_text(&mut ws1).await;
        let _ = read_next_text(&mut ws2).await;
        let _ = read_next_text(&mut ws2).await;
        let _ = read_next_text(&mut ws_other).await;
        let _ = read_next_text(&mut ws_other).await;

        ws1.send(awc::ws::Message::Text(
            json!({"type":"message","body":"hello room"}).to_string().into(),
        ))
        .await
        .expect("message send should succeed");

        let incoming1 = read_next_text(&mut ws1).await;
        let incoming2 = read_next_text(&mut ws2).await;
        assert_eq!(incoming1["type"], "message");
        assert_eq!(incoming2["type"], "message");
        assert_eq!(incoming1["item"]["body"], "hello room");
        assert_eq!(incoming2["item"]["body"], "hello room");

        let other_result =
            actix_web::rt::time::timeout(Duration::from_millis(300), ws_other.next()).await;
        assert!(other_result.is_err(), "other room should not receive broadcast");

        handle.stop(true).await;
    }
}
