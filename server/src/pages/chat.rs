use actix::{Actor, Addr, AsyncContext, Handler, Message, StreamHandler};
use actix_web::http::header;
use actix_web::{Error, HttpRequest, HttpResponse, Result, get, web};
use actix_web_actors::ws;
use log::{info, warn};
use rand::random;
use std::sync::LazyLock;
use tera::Context;

use super::utils;
use crate::app::AppCtx;
use crate::attachments::MAX_ATTACHMENT_SIZE_BYTES;
use crate::attachments::service::{
    UploadSessionState, decode_upload_chunk, download_end_payload, download_start_payload,
    encode_download_chunk, load_attachment_for_download, persist_upload, split_into_chunks,
    upload_done_payload, upload_ready_payload,
};
use crate::chat::service::{self as chat_service, ChatSessionState, ClientEvent, RoomRegistry};

static CHAT_ROOMS: LazyLock<RoomRegistry<ChatWs>> = LazyLock::new(RoomRegistry::new);

#[derive(Message)]
#[rtype(result = "()")]
struct PushEvent(String);

#[derive(Message)]
#[rtype(result = "()")]
struct PushBinary(Vec<u8>);

struct ChatWs {
    app_ctx: web::Data<AppCtx>,
    room_id: String,
    sender_id: String,
    session: ChatSessionState,
    is_registered: bool,
    uploads: UploadSessionState,
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

#[get("/chat/{room_id}")]
pub async fn chat_room_page_handler(
    req: HttpRequest,
    room_id: web::Path<String>,
) -> Result<HttpResponse> {
    let mut ctx = Context::new();
    let room = room_id.into_inner();
    ctx.insert("room_id", &room);
    ctx.insert("bundle_name", "chat");
    utils::render(req, "chat.html", &ctx).await
}

#[get("/ws/chat/{room_id}")]
pub async fn chat_ws_page_handler(
    req: HttpRequest,
    stream: web::Payload,
    room_id: web::Path<String>,
) -> Result<HttpResponse, Error> {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let Some(origin) = origin else {
        warn!(
            "event=chat_error room_id={} sender_id=null code=FORBIDDEN_ORIGIN request_id=null error=missing_origin",
            room_id.as_str()
        );
        return Err(actix_web::error::ErrorForbidden("Origin is required."));
    };
    if !chat_service::is_allowed_origin(origin) {
        warn!(
            "event=chat_error room_id={} sender_id=null code=FORBIDDEN_ORIGIN request_id=null error=origin_not_allowed origin={}",
            room_id.as_str(),
            origin
        );
        return Err(actix_web::error::ErrorForbidden("Origin is not allowed."));
    }
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
            session: ChatSessionState::new(),
            is_registered: false,
            uploads: UploadSessionState::new(),
        },
        &req,
        stream,
    )
    .frame_size(chat_service::WS_FRAME_MAX_BYTES)
    .start()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::db as chat_db;
    use crate::chat::service::WS_MAX_PAYLOAD_BYTES;
    use actix_web::{App, HttpServer};
    use futures_util::{SinkExt, Stream, StreamExt};
    use r2d2_sqlite::SqliteConnectionManager;
    use serde_json::json;
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
        conn.execute("PRAGMA foreign_keys = ON", ())
            .expect("foreign keys should be enabled");
        conn.execute(
            format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )",
                chat_db::CHAT_ROOMS_TABLE
            )
            .as_str(),
            (),
        )
        .expect("rooms table should be created");

        conn.execute(
            format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id INTEGER NOT NULL,
                    sender_id TEXT NOT NULL,
                    sender_name TEXT NOT NULL,
                    body TEXT NOT NULL CHECK(length(body) <= {}),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(room_id) REFERENCES {}(id) ON DELETE CASCADE
                )",
                chat_db::CHAT_MESSAGES_TABLE,
                crate::chat::service::MAX_MESSAGE_LEN,
                chat_db::CHAT_ROOMS_TABLE
            )
            .as_str(),
            (),
        )
        .expect("messages table should be created");

        conn.execute(
            format!(
                "CREATE INDEX IF NOT EXISTS idx_messages_room_created_at ON {}(room_id, created_at)",
                chat_db::CHAT_MESSAGES_TABLE
            )
            .as_str(),
            (),
        )
        .expect("messages index should be created");

        crate::attachments::db::init_attachments_schema(&conn)
            .expect("attachments schema should be initialized");
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
        chat_db::create_room_if_not_exists(&ctx, &room_id)
            .await
            .expect("room should be created");
        chat_db::insert_message(&ctx, &room_id, "u1", "alice", "hello history")
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
            .set_header("Origin", "http://localhost:8080")
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
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .expect("ws1 connect should succeed");
        let (_resp2, mut ws2) = awc::Client::new()
            .ws(ws_url_2)
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .expect("ws2 connect should succeed");
        let (_resp_other, mut ws_other) = awc::Client::new()
            .ws(ws_url_other)
            .set_header("Origin", "http://localhost:8080")
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
                json!({"type":"join","nickname":"charlie"})
                    .to_string()
                    .into(),
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
            json!({"type":"message","body":"hello room"})
                .to_string()
                .into(),
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
        assert!(
            other_result.is_err(),
            "other room should not receive broadcast"
        );

        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn oversized_payload_returns_bad_payload_and_connection_survives() {
        let ctx = setup_ctx();
        let room_id = format!("room-{}", random::<u64>());
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
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .expect("ws connect should succeed");

        let oversized = json!({
            "type": "message",
            "requestId": "too-big",
            "body": "x".repeat(WS_MAX_PAYLOAD_BYTES),
        })
        .to_string();
        ws.send(awc::ws::Message::Text(oversized.into()))
            .await
            .expect("oversized message should be sent");
        let bad_payload = read_next_text(&mut ws).await;
        assert_eq!(bad_payload["type"], "error");
        assert_eq!(bad_payload["code"], "BAD_PAYLOAD");

        ws.send(awc::ws::Message::Text(
            json!({
                "type": "join",
                "requestId": "join-after-oversized",
                "nickname": "dima"
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("join should be sent");
        let first = read_next_text(&mut ws).await;
        let second = read_next_text(&mut ws).await;
        assert!(
            first["type"] == "joined" || second["type"] == "joined",
            "connection should remain alive after bad payload"
        );

        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn rate_limit_returns_rate_limited_error() {
        let ctx = setup_ctx();
        let room_id = format!("room-{}", random::<u64>());
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
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .expect("ws connect should succeed");

        ws.send(awc::ws::Message::Text(
            json!({
                "type": "join",
                "requestId": "join-rate",
                "nickname": "alice"
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("join should be sent");
        let _ = read_next_text(&mut ws).await;
        let _ = read_next_text(&mut ws).await;

        for i in 0..(chat_service::RATE_LIMIT_MAX_MESSAGES + 1) {
            ws.send(awc::ws::Message::Text(
                json!({
                    "type": "message",
                    "requestId": format!("msg-{i}"),
                    "body": format!("hello-{i}")
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("message should be sent");
        }

        let mut rate_limited = false;
        for _ in 0..(chat_service::RATE_LIMIT_MAX_MESSAGES + 2) {
            let incoming = read_next_text(&mut ws).await;
            if incoming["type"] == "error" && incoming["code"] == "RATE_LIMITED" {
                rate_limited = true;
                break;
            }
        }
        assert!(rate_limited, "rate limit should trigger RATE_LIMITED error");

        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn malformed_payload_does_not_break_connection() {
        let ctx = setup_ctx();
        let room_id = format!("room-{}", random::<u64>());
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
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .expect("ws connect should succeed");

        ws.send(awc::ws::Message::Text("not-json".into()))
            .await
            .expect("malformed payload should be sent");
        let bad_payload = read_next_text(&mut ws).await;
        assert_eq!(bad_payload["type"], "error");
        assert_eq!(bad_payload["code"], "BAD_PAYLOAD");

        ws.send(awc::ws::Message::Text(
            json!({
                "type": "join",
                "requestId": "join-after-bad-json",
                "nickname": "alice"
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("join should be sent");
        let first = read_next_text(&mut ws).await;
        let second = read_next_text(&mut ws).await;
        assert!(
            first["type"] == "joined" || second["type"] == "joined",
            "socket should remain usable after malformed payload"
        );

        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn delete_broadcasts_deleted_event_to_room_clients() {
        let ctx = setup_ctx();
        let room_id = format!("room-{}", random::<u64>());

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
        let (_resp1, mut ws1) = awc::Client::new()
            .ws(ws_url_1)
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .expect("ws1 connect should succeed");
        let (_resp2, mut ws2) = awc::Client::new()
            .ws(ws_url_2)
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .expect("ws2 connect should succeed");

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

        let _ = read_next_text(&mut ws1).await;
        let _ = read_next_text(&mut ws1).await;
        let _ = read_next_text(&mut ws2).await;
        let _ = read_next_text(&mut ws2).await;

        ws1.send(awc::ws::Message::Text(
            json!({"type":"message","requestId":"msg-1","body":"hello"})
                .to_string()
                .into(),
        ))
        .await
        .expect("message send should succeed");

        let sent_to_ws1 = read_next_text(&mut ws1).await;
        let sent_to_ws2 = read_next_text(&mut ws2).await;
        assert_eq!(sent_to_ws1["type"], "message");
        assert_eq!(sent_to_ws2["type"], "message");
        let message_id = sent_to_ws1["item"]["id"]
            .as_i64()
            .expect("message id should be present");

        ws2.send(awc::ws::Message::Text(
            json!({
                "type":"delete",
                "requestId":"del-1",
                "messageId": message_id
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("delete send should succeed");

        let deleted1 = read_next_text(&mut ws1).await;
        let deleted2 = read_next_text(&mut ws2).await;
        assert_eq!(deleted1["type"], "deleted");
        assert_eq!(deleted2["type"], "deleted");
        assert_eq!(deleted1["messageId"], message_id);
        assert_eq!(deleted2["messageId"], message_id);

        handle.stop(true).await;
    }

    // ── Attachment helpers ────────────────────────────────────────────────────

    /// Read text frames until one matches predicate, skipping others (up to `max` frames).
    async fn find_text<S, F>(socket: &mut S, max: usize, pred: F) -> Option<serde_json::Value>
    where
        S: Stream<Item = Result<awc::ws::Frame, awc::error::WsProtocolError>> + Unpin,
        F: Fn(&serde_json::Value) -> bool,
    {
        for _ in 0..max {
            let frame = actix_web::rt::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .ok()??
                .ok()?;
            if let awc::ws::Frame::Text(text) = frame {
                let v: serde_json::Value =
                    serde_json::from_str(std::str::from_utf8(&text).ok()?).ok()?;
                if pred(&v) {
                    return Some(v);
                }
            }
        }
        None
    }

    async fn read_next_binary<S>(socket: &mut S) -> Option<actix_web::web::Bytes>
    where
        S: Stream<Item = Result<awc::ws::Frame, awc::error::WsProtocolError>> + Unpin,
    {
        loop {
            let frame = actix_web::rt::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .ok()??
                .ok()?;
            if let awc::ws::Frame::Binary(b) = frame {
                return Some(b);
            }
        }
    }

    fn encode_upload_chunk_frame(upload_id: u32, index: u32, data: &[u8]) -> Vec<u8> {
        fn varint(v: u64) -> Vec<u8> {
            let mut b = Vec::new();
            let mut val = v;
            loop {
                let byte = (val & 0x7F) as u8;
                val >>= 7;
                if val == 0 {
                    b.push(byte);
                    break;
                } else {
                    b.push(byte | 0x80);
                }
            }
            b
        }
        let mut buf = Vec::new();
        buf.extend(varint((1 << 3) | 0));
        buf.extend(varint(upload_id as u64));
        buf.extend(varint((2 << 3) | 0));
        buf.extend(varint(index as u64));
        buf.extend(varint((3 << 3) | 2));
        buf.extend(varint(data.len() as u64));
        buf.extend_from_slice(data);
        buf
    }

    fn extract_download_data(bin: &[u8]) -> Vec<u8> {
        fn read_varint(buf: &[u8], pos: &mut usize) -> u64 {
            let mut result = 0u64;
            let mut shift = 0u32;
            loop {
                let b = buf[*pos];
                *pos += 1;
                result |= ((b & 0x7f) as u64) << shift;
                shift += 7;
                if b & 0x80 == 0 {
                    break;
                }
            }
            result
        }
        let mut pos = 0;
        while pos < bin.len() {
            let tw = read_varint(bin, &mut pos);
            let field = (tw >> 3) as u32;
            let wire = tw & 0x7;
            if field == 3 && wire == 2 {
                let len = read_varint(bin, &mut pos) as usize;
                return bin[pos..pos + len].to_vec();
            } else if wire == 0 {
                read_varint(bin, &mut pos);
            } else if wire == 2 {
                let len = read_varint(bin, &mut pos) as usize;
                pos += len;
            } else {
                break;
            }
        }
        Vec::new()
    }

    macro_rules! spawn_server {
        ($ctx:expr) => {{
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let sctx = $ctx.clone();
            let server = HttpServer::new(move || {
                App::new()
                    .app_data(sctx.clone())
                    .service(chat_ws_page_handler)
            })
            .listen(listener)
            .unwrap()
            .run();
            let handle = server.handle();
            actix_web::rt::spawn(server);
            (addr, handle)
        }};
    }

    macro_rules! ws_join {
        ($addr:expr, $room:expr, $nick:expr) => {{
            let (_r, mut ws) = awc::Client::new()
                .ws(format!("ws://{}/ws/chat/{}", $addr, $room))
                .set_header("Origin", "http://localhost:8080")
                .connect().await.unwrap();
            ws.send(awc::ws::Message::Text(
                json!({"type":"join","nickname":$nick}).to_string().into()
            )).await.unwrap();
            let _ = read_next_text(&mut ws).await;
            let _ = read_next_text(&mut ws).await;
            ws
        }};
    }

    #[actix_web::test]
    async fn upload_happy_path() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();
        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room, "alice");

        let file_data = b"hello upload world";
        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":"up-1","messageId":msg.id,
                "filename":"test.txt","size":file_data.len(),"mimeType":"text/plain"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let ready = read_next_text(&mut ws).await;
        assert_eq!(ready["type"], "upload_ready");
        let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

        ws.send(awc::ws::Message::Binary(
            encode_upload_chunk_frame(upload_id, 0, file_data).into(),
        ))
        .await
        .unwrap();
        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_end","requestId":"up-1","uploadId":upload_id
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let done = find_text(&mut ws, 5, |v| v["type"] == "upload_done")
            .await
            .expect("upload_done");
        assert_eq!(done["attachment"]["filename"], "test.txt");
        assert!(done["attachment"]["id"].as_i64().unwrap() > 0);
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn download_happy_path() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();

        let file_data: Vec<u8> = (0u8..=255).cycle().take(200).collect();
        let attachment_id = {
            let conn = ctx.pool.get().unwrap();
            crate::attachments::db::insert_attachment(
                &conn,
                msg.id,
                "blob.bin",
                file_data.len() as i64,
                "application/octet-stream",
                &file_data,
            )
            .unwrap()
            .meta
            .id
        };

        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room, "alice");

        ws.send(awc::ws::Message::Text(
            json!({
                "type":"download_request","requestId":"dl-1","attachmentId":attachment_id
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let start = find_text(&mut ws, 5, |v| v["type"] == "download_start")
            .await
            .expect("download_start");
        let total_chunks = start["totalChunks"].as_u64().unwrap() as usize;

        let mut received: Vec<u8> = Vec::new();
        for _ in 0..total_chunks {
            let bin = read_next_binary(&mut ws).await.expect("binary chunk");
            received.extend(extract_download_data(&bin));
        }

        let end = find_text(&mut ws, 5, |v| v["type"] == "download_end")
            .await
            .expect("download_end");
        assert_eq!(end["attachmentId"], attachment_id);
        assert_eq!(received, file_data);
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn upload_out_of_order_chunk() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();
        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room, "alice");

        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":"up-oo","messageId":msg.id,
                "filename":"f.bin","size":10,"mimeType":"application/octet-stream"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let ready = read_next_text(&mut ws).await;
        let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

        ws.send(awc::ws::Message::Binary(
            encode_upload_chunk_frame(upload_id, 1, &[0u8; 5]).into(),
        ))
        .await
        .unwrap();

        let err = find_text(&mut ws, 5, |v| v["type"] == "error")
            .await
            .expect("error");
        assert_eq!(err["code"], "UPLOAD_CHUNK_OUT_OF_ORDER");
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn upload_early_end() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();
        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room, "alice");

        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":"up-early","messageId":msg.id,
                "filename":"f.bin","size":10,"mimeType":"application/octet-stream"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let ready = read_next_text(&mut ws).await;
        let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

        ws.send(awc::ws::Message::Binary(
            encode_upload_chunk_frame(upload_id, 0, &[1u8; 5]).into(),
        ))
        .await
        .unwrap();
        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_end","requestId":"up-early","uploadId":upload_id
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let err = find_text(&mut ws, 5, |v| v["type"] == "error")
            .await
            .expect("error");
        assert_eq!(err["code"], "UPLOAD_INCOMPLETE");
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn upload_unknown_id() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room, "alice");

        ws.send(awc::ws::Message::Binary(
            encode_upload_chunk_frame(9999, 0, b"data").into(),
        ))
        .await
        .unwrap();

        let err = find_text(&mut ws, 5, |v| v["type"] == "error")
            .await
            .expect("error");
        assert_eq!(err["code"], "UPLOAD_NOT_FOUND");
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn upload_session_limit() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();
        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room, "alice");

        for i in 0..crate::attachments::MAX_PENDING_UPLOADS_PER_SESSION {
            ws.send(awc::ws::Message::Text(
                json!({
                    "type":"upload_start","requestId":format!("up-{i}"),"messageId":msg.id,
                    "filename":"f.bin","size":5,"mimeType":"application/octet-stream"
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            let r = read_next_text(&mut ws).await;
            assert_eq!(r["type"], "upload_ready");
        }

        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":"up-limit","messageId":msg.id,
                "filename":"f.bin","size":5,"mimeType":"application/octet-stream"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let err = find_text(&mut ws, 5, |v| v["type"] == "error")
            .await
            .expect("error");
        assert_eq!(err["code"], "UPLOAD_LIMIT_EXCEEDED");
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn download_wrong_room() {
        let ctx = setup_ctx();
        let room_a = format!("room-a-{}", random::<u64>());
        let room_b = format!("room-b-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room_a)
            .await
            .unwrap();
        chat_db::create_room_if_not_exists(&ctx, &room_b)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room_a, "u1", "alice", "hi")
            .await
            .unwrap();

        let attachment_id = {
            let conn = ctx.pool.get().unwrap();
            crate::attachments::db::insert_attachment(
                &conn,
                msg.id,
                "secret.txt",
                6,
                "text/plain",
                b"secret",
            )
            .unwrap()
            .meta
            .id
        };

        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room_b, "bob");

        ws.send(awc::ws::Message::Text(
            json!({
                "type":"download_request","requestId":"dl-scope","attachmentId":attachment_id
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let err = find_text(&mut ws, 5, |v| v["type"] == "error")
            .await
            .expect("error");
        assert_eq!(err["code"], "ATTACHMENT_NOT_FOUND");
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn disconnect_cancels_upload() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();
        let (addr, handle) = spawn_server!(ctx.clone());

        {
            let mut ws = ws_join!(addr, room, "alice");
            ws.send(awc::ws::Message::Text(
                json!({
                    "type":"upload_start","requestId":"up-dc","messageId":msg.id,
                    "filename":"f.bin","size":10,"mimeType":"application/octet-stream"
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            let r = read_next_text(&mut ws).await;
            assert_eq!(r["type"], "upload_ready");
            // drop ws without upload_end
        }

        actix_web::rt::time::sleep(Duration::from_millis(200)).await;
        let conn = ctx.pool.get().unwrap();
        let count: i64 = conn
            .query_row(
                format!(
                    "SELECT COUNT(*) FROM {}",
                    crate::attachments::db::ATTACHMENTS_TABLE
                )
                .as_str(),
                (),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "incomplete upload must not be persisted");
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn upload_done_broadcast() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();
        let (addr, handle) = spawn_server!(ctx);
        let mut ws1 = ws_join!(addr, room, "alice");
        let mut ws2 = ws_join!(addr, room, "bob");

        let file_data = b"broadcast test";
        ws1.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":"up-bc","messageId":msg.id,
                "filename":"bc.txt","size":file_data.len(),"mimeType":"text/plain"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let ready = read_next_text(&mut ws1).await;
        let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

        ws1.send(awc::ws::Message::Binary(
            encode_upload_chunk_frame(upload_id, 0, file_data).into(),
        ))
        .await
        .unwrap();
        ws1.send(awc::ws::Message::Text(
            json!({
                "type":"upload_end","requestId":"up-bc","uploadId":upload_id
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let done1 = find_text(&mut ws1, 5, |v| v["type"] == "upload_done")
            .await
            .expect("ws1 upload_done");
        let done2 = find_text(&mut ws2, 5, |v| v["type"] == "upload_done")
            .await
            .expect("ws2 upload_done");
        assert_eq!(done1["attachment"]["filename"], "bc.txt");
        assert_eq!(done2["attachment"]["filename"], "bc.txt");
        assert_eq!(done1["attachment"]["id"], done2["attachment"]["id"]);
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn upload_start_rejects_oversized_size() {
        let ctx = setup_ctx();
        let room = format!("room-{}", random::<u64>());
        chat_db::create_room_if_not_exists(&ctx, &room)
            .await
            .unwrap();
        let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
            .await
            .unwrap();
        let (addr, handle) = spawn_server!(ctx);
        let mut ws = ws_join!(addr, room, "alice");

        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":"up-big","messageId":msg.id,
                "filename":"big.bin",
                "size": crate::attachments::MAX_ATTACHMENT_SIZE_BYTES + 1,
                "mimeType":"application/octet-stream"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let err = find_text(&mut ws, 5, |v| v["type"] == "error")
            .await
            .expect("error");
        assert_eq!(err["code"], "UPLOAD_TOO_LARGE");
        handle.stop(true).await;
    }
}
