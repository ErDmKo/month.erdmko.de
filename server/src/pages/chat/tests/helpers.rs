pub(super) use super::super::*;
pub(super) use crate::chat::db as chat_db;
pub(super) use crate::chat::service::WS_MAX_PAYLOAD_BYTES;
pub(super) use actix_web::{App, HttpServer};
pub(super) use futures_util::{SinkExt, Stream, StreamExt};
pub(super) use r2d2_sqlite::SqliteConnectionManager;
pub(super) use serde_json::json;
pub(super) use std::net::TcpListener;
pub(super) use std::path::PathBuf;
pub(super) use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

pub(super) async fn read_next_text<S>(socket: &mut S) -> serde_json::Value
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

pub(super) async fn find_text<S, F>(
    socket: &mut S,
    max: usize,
    pred: F,
) -> Option<serde_json::Value>
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

pub(super) async fn read_next_binary<S>(socket: &mut S) -> Option<actix_web::web::Bytes>
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

pub(super) fn encode_upload_chunk_frame(upload_id: u32, index: u32, data: &[u8]) -> Vec<u8> {
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

pub(super) fn extract_download_data(bin: &[u8]) -> Vec<u8> {
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
pub(super) use spawn_server;

macro_rules! ws_join {
    ($addr:expr, $room:expr, $nick:expr) => {{
        let (_r, mut ws) = awc::Client::new()
            .ws(format!("ws://{}/ws/chat/{}", $addr, $room))
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .unwrap();
        ws.send(awc::ws::Message::Text(
            json!({"type":"join","nickname":$nick})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let _ = read_next_text(&mut ws).await;
        let _ = read_next_text(&mut ws).await;
        ws
    }};
}
pub(super) use ws_join;
