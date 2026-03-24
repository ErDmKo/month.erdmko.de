use actix_web::{error, web};
use log;
use r2d2_sqlite::{self, SqliteConnectionManager};
use rusqlite::params_from_iter;
use rusqlite::types::ValueRef;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::app::AppCtx;
use crate::app::Pool;
use crate::chat::{HISTORY_LIMIT, MAX_MESSAGE_LEN};

pub static TABLE_NAME: &'static str = "prompt";
pub static CHAT_ROOMS_TABLE: &str = "rooms";
pub static CHAT_MESSAGES_TABLE: &str = "messages";

#[derive(Debug, Serialize, Deserialize)]
pub struct CountResult {
    c: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlResult {
    pub id: i32,
    pub prompt: String,
    pub data: Option<Vec<u8>>,
    // state = 0 - pending execute
    // state = 1 - executing
    // state = 2 - success
    // state = 3 - fail
    pub state: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub room_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub body: String,
    pub created_at: String,
}

fn init_pool(base_dir: &mut PathBuf) -> Result<Pool, r2d2::Error> {
    base_dir.push("db");
    base_dir.push("main.db");
    log::info!("Db pool start {:?}", base_dir);
    let manager = SqliteConnectionManager::file(base_dir);
    let pool = Pool::new(manager)?;
    Ok(pool)
}

pub async fn init_db(base_dir: &mut PathBuf) -> Result<Pool, rusqlite::Error> {
    log::info!("Init db");
    let pool = init_pool(base_dir).map_err(|e| {
        let error_text = format!("Pool error {e:?}");
        rusqlite::Error::InvalidParameterName(error_text)
    })?;
    let conn = pool.get().unwrap();

    let drop_query = format!("DROP TABLE IF EXISTS {TABLE_NAME}");
    conn.execute(&drop_query, ())?;
    let drop_query = format!("DROP TABLE IF EXISTS token");
    conn.execute(&drop_query, ())?;

    let create_query = format!(
        "\
            CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
            id    INTEGER PRIMARY KEY,
            promt  TEXT NOT NULL,
            datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            data BLOB,
            state INTEGER DEFAULT 0
    )"
    );
    conn.execute(&create_query, ())?;
    let token_query = format!(
        "
       CREATE TABLE IF NOT EXISTS token (
       id    INTEGER PRIMARY KEY,
       token  TEXT NOT NULL,
       datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );"
    );
    conn.execute(&token_query, ())?;
    let chat_rooms_query = format!(
        "\
       CREATE TABLE IF NOT EXISTS {CHAT_ROOMS_TABLE} (
       id TEXT PRIMARY KEY,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );"
    );
    conn.execute(&chat_rooms_query, ())?;
    let chat_messages_query = format!(
        "\
       CREATE TABLE IF NOT EXISTS {CHAT_MESSAGES_TABLE} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       room_id TEXT NOT NULL,
       sender_id TEXT NOT NULL,
       sender_name TEXT NOT NULL,
       body TEXT NOT NULL CHECK(length(body) <= {MAX_MESSAGE_LEN}),
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );"
    );
    conn.execute(&chat_messages_query, ())?;
    conn.execute(
        format!(
            "CREATE INDEX IF NOT EXISTS idx_messages_room_created_at ON {CHAT_MESSAGES_TABLE}(room_id, created_at)"
        )
        .as_str(),
        (),
    )?;
    let random_seed = rand::random::<u64>().to_string();
    let token = format!("im_{random_seed}");
    log::info!("Admin token {:?}", token);
    conn.execute(
        format!("INSERT INTO token (token) VALUES (?1)").as_str(),
        (token,),
    )?;
    conn.execute(
        format!("INSERT INTO {TABLE_NAME} (promt) VALUES (?1)").as_str(),
        ("1girl, oshi no ko, solo, upper body, v, smile, looking at viewer, outdoors, night",),
    )?;
    Ok(pool)
}

fn validate_chat_message_body(body: &str) -> actix_web::Result<String> {
    let trimmed = body.trim();
    let body_len = trimmed.chars().count();
    if body_len == 0 || body_len > MAX_MESSAGE_LEN {
        return Err(error::ErrorBadRequest(format!(
            "message length must be between 1 and {MAX_MESSAGE_LEN}"
        )));
    }
    Ok(trimmed.to_string())
}

pub async fn create_room_if_not_exists(
    app_ctx: &web::Data<AppCtx>,
    room_id: &str,
) -> actix_web::Result<()> {
    let room = room_id.trim();
    if room.is_empty() {
        return Err(error::ErrorBadRequest("room id is required"));
    }
    let pool = app_ctx.pool.clone();
    let room_id = room.to_string();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!("INSERT OR IGNORE INTO {CHAT_ROOMS_TABLE} (id) VALUES (?1)").as_str(),
        (room_id,),
    )
    .map_err(error::ErrorInternalServerError)?;
    Ok(())
}

pub async fn insert_message(
    app_ctx: &web::Data<AppCtx>,
    room_id: &str,
    sender_id: &str,
    sender_name: &str,
    body: &str,
) -> actix_web::Result<ChatMessage> {
    let room = room_id.trim();
    if room.is_empty() {
        return Err(error::ErrorBadRequest("room id is required"));
    }
    let sender = sender_id.trim();
    if sender.is_empty() {
        return Err(error::ErrorBadRequest("sender id is required"));
    }
    let sender_name = sender_name.trim();
    if sender_name.is_empty() {
        return Err(error::ErrorBadRequest("sender name is required"));
    }
    let body = validate_chat_message_body(body)?;
    let pool = app_ctx.pool.clone();
    let room_id = room.to_string();
    let sender_id = sender.to_string();
    let sender_name = sender_name.to_string();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!(
            "INSERT INTO {CHAT_MESSAGES_TABLE} (room_id, sender_id, sender_name, body) VALUES (?1, ?2, ?3, ?4)"
        )
        .as_str(),
        (&room_id, &sender_id, &sender_name, &body),
    )
    .map_err(error::ErrorInternalServerError)?;
    let id = conn.last_insert_rowid();
    let mut stmt = conn
        .prepare(
            format!(
                "SELECT id, room_id, sender_id, sender_name, body, datetime(created_at) as created_at \
                FROM {CHAT_MESSAGES_TABLE} WHERE id = ?1"
            )
            .as_str(),
        )
        .map_err(error::ErrorInternalServerError)?;
    let inserted = stmt
        .query_row((id,), |row| {
            Ok(ChatMessage {
                id: row.get("id")?,
                room_id: row.get("room_id")?,
                sender_id: row.get("sender_id")?,
                sender_name: row.get("sender_name")?,
                body: row.get("body")?,
                created_at: row.get("created_at")?,
            })
        })
        .map_err(error::ErrorInternalServerError)?;

    Ok(inserted)
}

pub async fn get_recent_messages(
    app_ctx: &web::Data<AppCtx>,
    room_id: &str,
    limit: Option<usize>,
) -> actix_web::Result<Vec<ChatMessage>> {
    let room = room_id.trim();
    if room.is_empty() {
        return Err(error::ErrorBadRequest("room id is required"));
    }
    let query_limit = limit
        .unwrap_or(HISTORY_LIMIT)
        .max(1)
        .min(HISTORY_LIMIT) as i64;
    let pool = app_ctx.pool.clone();
    let room_id = room.to_string();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    let mut stmt = conn
        .prepare(
            format!(
                "SELECT id, room_id, sender_id, sender_name, body, datetime(created_at) as created_at \
                FROM {CHAT_MESSAGES_TABLE} \
                WHERE room_id = ?1 \
                ORDER BY id DESC \
                LIMIT ?2"
            )
            .as_str(),
        )
        .map_err(error::ErrorInternalServerError)?;

    let mut rows: Vec<ChatMessage> = stmt
        .query_map((room_id, query_limit), |row| {
            Ok(ChatMessage {
                id: row.get("id")?,
                room_id: row.get("room_id")?,
                sender_id: row.get("sender_id")?,
                sender_name: row.get("sender_name")?,
                body: row.get("body")?,
                created_at: row.get("created_at")?,
            })
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(error::ErrorInternalServerError)?;

    rows.reverse();
    Ok(rows)
}

pub async fn check_token(app_ctx: &web::Data<AppCtx>, token: &str) -> actix_web::Result<bool> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    let q = format!("SELECT id as c from token where token=?1");
    let mut stmt = conn.prepare(&q).map_err(error::ErrorInternalServerError)?;
    let r = stmt
        .query_map((token,), |row| Ok(CountResult { c: row.get("c")? }))
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(error::ErrorInternalServerError)?;

    Ok(r.len() != 0)
}

pub async fn insert_promt(app_ctx: &web::Data<AppCtx>, promt: &String) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!("INSERT into {TABLE_NAME} (promt) VALUES (?1)").as_str(),
        (promt,),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    conn.execute(
        format!(
            "DELETE FROM {TABLE_NAME}
        WHERE id NOT IN (
            SELECT id
            FROM {TABLE_NAME}
            ORDER BY id DESC
            LIMIT 10
        )"
        )
        .as_str(),
        (),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(1)
}

pub async fn insert_data_promt(
    app_ctx: &web::Data<AppCtx>,
    id: &String,
    data: Vec<u8>,
) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!("UPDATE {TABLE_NAME} set data=?1, state=2 where id=?2").as_str(),
        (data, id),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(1)
}

pub async fn insert_status_promt(
    app_ctx: &web::Data<AppCtx>,
    id: &String,
    status: &String,
) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!("UPDATE {TABLE_NAME} set state=?1 where id=?2").as_str(),
        (status, id),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(1)
}

pub async fn delete_promt(app_ctx: &web::Data<AppCtx>, id: &i32) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    let delete_qury = format!("DELETE from {TABLE_NAME} where id = ?1");
    conn.execute(&delete_qury, (id,)).map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(*id)
}

pub async fn query_promts(
    app_ctx: web::Data<AppCtx>,
    state: Option<i32>,
) -> actix_web::Result<Vec<SqlResult>> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    let mut lis = vec![];

    let query_result = web::block(move || {
        let (params, query) = match state {
            Some(status) => {
                let q = format!(
                    "\
                    SELECT id, promt, state, data \
                    FROM {TABLE_NAME} \
                    WHERE state=?1 \
                    order by datetime desc"
                );
                lis.push(status);
                let p = params_from_iter(lis.iter());
                (p, q)
            }
            None => {
                let q = format!(
                    "\
                    SELECT id, promt, state, data \
                    FROM {TABLE_NAME} \
                    order by datetime desc"
                );
                (params_from_iter([].iter()), q)
            }
        };
        let mut stmt = conn.prepare(&query)?;
        let r = stmt
            .query_map(params, |row| {
                let bytes = row.get_ref("data")?;
                Ok(SqlResult {
                    id: row.get("id")?,
                    prompt: row.get("promt")?,
                    state: row.get("state")?,
                    data: match bytes {
                        ValueRef::Blob(byte) => Some(byte.to_vec()),
                        _ => None,
                    },
                })
            })
            .and_then(Iterator::collect::<Result<Vec<_>, _>>);
        r
    })
    .await?
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;

    Ok(query_result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use r2d2_sqlite::SqliteConnectionManager;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn setup_ctx() -> web::Data<AppCtx> {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("month_chat_db_{unique_suffix}.sqlite"));

        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::new(manager).expect("pool should be created");
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
                CHAT_ROOMS_TABLE
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
                CHAT_MESSAGES_TABLE, MAX_MESSAGE_LEN
            )
            .as_str(),
            (),
        )
        .expect("messages table should be created");

        conn.execute(
            format!(
                "CREATE INDEX IF NOT EXISTS idx_messages_room_created_at ON {}(room_id, created_at)",
                CHAT_MESSAGES_TABLE
            )
            .as_str(),
            (),
        )
        .expect("messages index should be created");
    }

    #[actix_web::test]
    async fn create_room_is_idempotent() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "general")
            .await
            .expect("first room create should succeed");
        create_room_if_not_exists(&ctx, "general")
            .await
            .expect("second room create should succeed");

        let conn = ctx.pool.get().expect("pool connection should be available");
        let count: i64 = conn
            .query_row(
                format!("SELECT COUNT(*) FROM {} WHERE id = ?1", CHAT_ROOMS_TABLE).as_str(),
                ("general",),
                |row| row.get(0),
            )
            .expect("count query should succeed");
        assert_eq!(count, 1);
    }

    #[actix_web::test]
    async fn insert_and_fetch_recent_messages() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "general")
            .await
            .expect("room create should succeed");
        insert_message(&ctx, "general", "u1", "alice", "first")
            .await
            .expect("insert first message should succeed");
        insert_message(&ctx, "general", "u2", "bob", "second")
            .await
            .expect("insert second message should succeed");

        let messages = get_recent_messages(&ctx, "general", Some(50))
            .await
            .expect("recent messages query should succeed");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].body, "first");
        assert_eq!(messages[1].body, "second");
    }

    #[actix_web::test]
    async fn rejects_invalid_message_body() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "general")
            .await
            .expect("room create should succeed");

        let empty_result = insert_message(&ctx, "general", "u1", "alice", "   ").await;
        assert!(empty_result.is_err());

        let too_long = "x".repeat(MAX_MESSAGE_LEN + 1);
        let long_result = insert_message(&ctx, "general", "u1", "alice", too_long.as_str()).await;
        assert!(long_result.is_err());
    }
}
