pub(super) use super::super::*;
pub(super) use crate::chat::db as chat_db;
pub(super) use crate::chat::service::WS_MAX_PAYLOAD_BYTES;
pub(super) use actix_web::{App, HttpServer};
pub(super) use futures_util::{SinkExt, Stream, StreamExt};
pub(super) use prost::Message as ProstMessage;
pub(super) use r2d2_sqlite::SqliteConnectionManager;
pub(super) use std::net::TcpListener;
pub(super) use std::path::PathBuf;
pub(super) use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::generated::chat::{
    ClientDelete, ClientDownloadRequest, ClientFrame, ClientJoin, ClientMessage, ClientUploadEnd,
    ClientUploadStart, ServerFrame, UploadChunk, client_frame, server_frame,
};

// ── DB / server setup ─────────────────────────────────────────────────────────

pub(super) fn setup_ctx() -> actix_web::web::Data<crate::app::AppCtx> {
    let unique_suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be valid")
        .as_nanos();
    let mut db_path = std::env::temp_dir();
    db_path.push(format!("month_chat_ws_db_{unique_suffix}.sqlite"));

    let manager = SqliteConnectionManager::file(db_path);
    let pool = crate::app::Pool::new(manager).expect("pool should be created");
    let ctx = actix_web::web::Data::new(crate::app::AppCtx {
        static_path: PathBuf::new(),
        pool,
    });
    prepare_chat_schema(&ctx);
    ctx
}

pub(super) fn prepare_chat_schema(ctx: &actix_web::web::Data<crate::app::AppCtx>) {
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

// ── ClientFrame encode ────────────────────────────────────────────────────────

pub(super) fn encode_join(request_id: &str, nickname: &str) -> Vec<u8> {
    ClientFrame {
        payload: Some(client_frame::Payload::Join(ClientJoin {
            request_id: request_id.to_string(),
            nickname: nickname.to_string(),
        })),
    }
    .encode_to_vec()
}

pub(super) fn encode_message(request_id: &str, body: &str) -> Vec<u8> {
    ClientFrame {
        payload: Some(client_frame::Payload::Message(ClientMessage {
            request_id: request_id.to_string(),
            body: body.to_string(),
        })),
    }
    .encode_to_vec()
}

pub(super) fn encode_delete(request_id: &str, message_id: i64) -> Vec<u8> {
    ClientFrame {
        payload: Some(client_frame::Payload::Delete(ClientDelete {
            request_id: request_id.to_string(),
            message_id,
        })),
    }
    .encode_to_vec()
}

pub(super) fn encode_upload_start(
    request_id: &str,
    message_id: i64,
    filename: &str,
    size: u32,
    mime_type: &str,
) -> Vec<u8> {
    ClientFrame {
        payload: Some(client_frame::Payload::UploadStart(ClientUploadStart {
            request_id: request_id.to_string(),
            message_id,
            filename: filename.to_string(),
            size,
            mime_type: mime_type.to_string(),
        })),
    }
    .encode_to_vec()
}

pub(super) fn encode_upload_end(request_id: &str, upload_id: u32) -> Vec<u8> {
    ClientFrame {
        payload: Some(client_frame::Payload::UploadEnd(ClientUploadEnd {
            request_id: request_id.to_string(),
            upload_id,
        })),
    }
    .encode_to_vec()
}

pub(super) fn encode_upload_chunk_frame(upload_id: u32, index: u32, data: &[u8]) -> Vec<u8> {
    ClientFrame {
        payload: Some(client_frame::Payload::UploadChunk(UploadChunk {
            upload_id,
            index,
            data: data.to_vec(),
        })),
    }
    .encode_to_vec()
}

pub(super) fn encode_download_request(request_id: &str, attachment_id: i64) -> Vec<u8> {
    ClientFrame {
        payload: Some(client_frame::Payload::DownloadRequest(
            ClientDownloadRequest {
                request_id: request_id.to_string(),
                attachment_id,
            },
        )),
    }
    .encode_to_vec()
}

// ── ServerFrame decode ────────────────────────────────────────────────────────

pub(super) fn decode_frame(bytes: &[u8]) -> server_frame::Payload {
    ServerFrame::decode(bytes)
        .expect("server frame should decode")
        .payload
        .expect("server frame should have payload")
}

pub(super) async fn read_next_binary<S>(socket: &mut S) -> server_frame::Payload
where
    S: Stream<Item = Result<awc::ws::Frame, awc::error::WsProtocolError>> + Unpin,
{
    loop {
        let frame = actix_web::rt::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("frame timeout")
            .expect("socket should stay open")
            .expect("frame should be valid");
        if let awc::ws::Frame::Binary(b) = frame {
            return decode_frame(&b);
        }
    }
}

pub(super) async fn find_binary<S, F>(
    socket: &mut S,
    max: usize,
    pred: F,
) -> Option<server_frame::Payload>
where
    S: Stream<Item = Result<awc::ws::Frame, awc::error::WsProtocolError>> + Unpin,
    F: Fn(&server_frame::Payload) -> bool,
{
    for _ in 0..max {
        let frame = actix_web::rt::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .ok()??
            .ok()?;
        if let awc::ws::Frame::Binary(b) = frame {
            let p = decode_frame(&b);
            if pred(&p) {
                return Some(p);
            }
        }
    }
    None
}

pub(super) fn unwrap_error(p: server_frame::Payload) -> crate::generated::chat::ServerError {
    match p {
        server_frame::Payload::Error(e) => e,
        other => panic!("expected Error frame, got {:?}", other),
    }
}

// ── Macros ────────────────────────────────────────────────────────────────────

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
pub(super) use spawn_server;

macro_rules! ws_join {
    ($addr:expr, $room:expr, $nick:expr) => {{
        let (_r, mut ws) = awc::Client::new()
            .ws(format!("ws://{}/ws/chat/{}", $addr, $room))
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .unwrap();
        ws.send(awc::ws::Message::Binary(encode_join("j", $nick).into()))
            .await
            .unwrap();
        let _ = read_next_binary(&mut ws).await; // joined
        let _ = read_next_binary(&mut ws).await; // history
        ws
    }};
}
pub(super) use ws_join;
