use actix_web::web;
use rusqlite;
use serde::{Deserialize, Serialize};

use crate::app::AppCtx;
use crate::chat::service::{
    HISTORY_LIMIT, MAX_MESSAGE_LEN, MAX_MESSAGES_STORAGE_BYTES, MAX_ROOMS_STORAGE_BYTES,
};
use super::error::{ChatError, ChatResult};

pub static CHAT_ROOMS_TABLE: &str = "rooms";
pub static CHAT_MESSAGES_TABLE: &str = "messages";

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub room_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub body: String,
    pub created_at: String,
}

fn ensure_foreign_keys(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute("PRAGMA foreign_keys = ON", ())?;
    Ok(())
}

pub fn init_chat_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    ensure_foreign_keys(conn)?;
    let chat_rooms_query = format!(
        "\
       CREATE TABLE IF NOT EXISTS {CHAT_ROOMS_TABLE} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       slug TEXT NOT NULL UNIQUE,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );"
    );
    conn.execute(&chat_rooms_query, ())?;

    let chat_messages_query = format!(
        "\
       CREATE TABLE IF NOT EXISTS {CHAT_MESSAGES_TABLE} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       room_id INTEGER NOT NULL,
       sender_id TEXT NOT NULL,
       sender_name TEXT NOT NULL,
       body TEXT NOT NULL CHECK(length(body) <= {MAX_MESSAGE_LEN}),
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY(room_id) REFERENCES {CHAT_ROOMS_TABLE}(id) ON DELETE CASCADE
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

    Ok(())
}

fn validate_chat_message_body(body: &str) -> ChatResult<String> {
    let trimmed = body.trim();
    let body_len = trimmed.chars().count();
    if body_len == 0 || body_len > MAX_MESSAGE_LEN {
        return Err(ChatError::validation(format!(
            "message length must be between 1 and {MAX_MESSAGE_LEN}"
        )));
    }
    Ok(trimmed.to_string())
}

fn enforce_messages_storage_limit(
    conn: &rusqlite::Connection,
    max_bytes: usize,
) -> rusqlite::Result<()> {
    let max_bytes = max_bytes as i64;
    loop {
        let current_total: i64 = conn.query_row(
            format!("SELECT COALESCE(SUM(LENGTH(body)), 0) FROM {CHAT_MESSAGES_TABLE}").as_str(),
            (),
            |row| row.get(0),
        )?;
        if current_total <= max_bytes {
            return Ok(());
        }
        let deleted = conn.execute(
            format!(
                "DELETE FROM {CHAT_MESSAGES_TABLE}
                 WHERE id IN (SELECT id FROM {CHAT_MESSAGES_TABLE} ORDER BY id ASC LIMIT 1)"
            )
            .as_str(),
            (),
        )?;
        if deleted == 0 {
            return Ok(());
        }
    }
}

fn enforce_rooms_storage_limit(conn: &rusqlite::Connection, max_bytes: usize) -> rusqlite::Result<()> {
    let max_bytes = max_bytes as i64;
    loop {
        let current_total: i64 = conn.query_row(
            format!("SELECT COALESCE(SUM(LENGTH(slug)), 0) FROM {CHAT_ROOMS_TABLE}").as_str(),
            (),
            |row| row.get(0),
        )?;
        if current_total <= max_bytes {
            return Ok(());
        }
        let deleted = conn.execute(
            format!(
                "DELETE FROM {CHAT_ROOMS_TABLE}
                 WHERE id IN (
                    SELECT r.id
                    FROM {CHAT_ROOMS_TABLE} r
                    LEFT JOIN {CHAT_MESSAGES_TABLE} m ON m.room_id = r.id
                    GROUP BY r.id
                    ORDER BY COUNT(m.id) ASC, r.created_at ASC, r.id ASC
                    LIMIT 1
                 )"
            )
            .as_str(),
            (),
        )?;
        if deleted == 0 {
            return Ok(());
        }
    }
}

pub async fn create_room_if_not_exists(
    app_ctx: &web::Data<AppCtx>,
    room_slug: &str,
) -> ChatResult<()> {
    let room = room_slug.trim();
    if room.is_empty() {
        return Err(ChatError::validation("room id is required"));
    }
    let pool = app_ctx.pool.clone();
    let room_slug = room.to_string();
    let conn = web::block(move || pool.get())
        .await
        .map_err(|err| ChatError::internal("DB worker failure.", format!("{err:?}")))?
        .map_err(|err| ChatError::internal("Failed to acquire DB connection.", format!("{err:?}")))?;
    ensure_foreign_keys(&conn)
        .map_err(|err| ChatError::internal("Failed to enable foreign keys.", format!("{err:?}")))?;
    conn.execute(
        format!("INSERT OR IGNORE INTO {CHAT_ROOMS_TABLE} (slug) VALUES (?1)").as_str(),
        (room_slug,),
    )
    .map_err(|err| ChatError::internal("Failed to create room.", format!("{err:?}")))?;
    enforce_rooms_storage_limit(&conn, MAX_ROOMS_STORAGE_BYTES)
        .map_err(|err| ChatError::internal("Failed to enforce room storage limit.", format!("{err:?}")))?;
    Ok(())
}

pub async fn insert_message(
    app_ctx: &web::Data<AppCtx>,
    room_slug: &str,
    sender_id: &str,
    sender_name: &str,
    body: &str,
) -> ChatResult<ChatMessage> {
    let room = room_slug.trim();
    if room.is_empty() {
        return Err(ChatError::validation("room id is required"));
    }
    let sender = sender_id.trim();
    if sender.is_empty() {
        return Err(ChatError::validation("sender id is required"));
    }
    let sender_name = sender_name.trim();
    if sender_name.is_empty() {
        return Err(ChatError::validation("sender name is required"));
    }
    let body = validate_chat_message_body(body)?;
    let pool = app_ctx.pool.clone();
    let room_slug = room.to_string();
    let sender_id = sender.to_string();
    let sender_name = sender_name.to_string();
    let conn = web::block(move || pool.get())
        .await
        .map_err(|err| ChatError::internal("DB worker failure.", format!("{err:?}")))?
        .map_err(|err| ChatError::internal("Failed to acquire DB connection.", format!("{err:?}")))?;
    ensure_foreign_keys(&conn)
        .map_err(|err| ChatError::internal("Failed to enable foreign keys.", format!("{err:?}")))?;
    let room_db_id: i64 = conn
        .query_row(
            format!("SELECT id FROM {CHAT_ROOMS_TABLE} WHERE slug = ?1").as_str(),
            (&room_slug,),
            |row| row.get(0),
        )
        .map_err(|_| ChatError::validation("room id is required"))?;
    conn.execute(
        format!(
            "INSERT INTO {CHAT_MESSAGES_TABLE} (room_id, sender_id, sender_name, body) VALUES (?1, ?2, ?3, ?4)"
        )
        .as_str(),
        (room_db_id, &sender_id, &sender_name, &body),
    )
    .map_err(|err| ChatError::internal("Failed to persist message.", format!("{err:?}")))?;
    let id = conn.last_insert_rowid();
    let mut stmt = conn
        .prepare(
            format!(
                "SELECT m.id, r.slug as room_id, m.sender_id, m.sender_name, m.body, datetime(m.created_at) as created_at
                FROM {CHAT_MESSAGES_TABLE} m
                JOIN {CHAT_ROOMS_TABLE} r ON r.id = m.room_id
                WHERE m.id = ?1"
            )
            .as_str(),
        )
        .map_err(|err| ChatError::internal("Failed to prepare inserted message query.", format!("{err:?}")))?;
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
        .map_err(|err| ChatError::internal("Failed to load inserted message.", format!("{err:?}")))?;
    enforce_messages_storage_limit(&conn, MAX_MESSAGES_STORAGE_BYTES)
        .map_err(|err| ChatError::internal("Failed to enforce message storage limit.", format!("{err:?}")))?;

    Ok(inserted)
}

pub async fn delete_message_by_id(
    app_ctx: &web::Data<AppCtx>,
    room_slug: &str,
    message_id: i64,
) -> ChatResult<bool> {
    let room = room_slug.trim();
    if room.is_empty() {
        return Err(ChatError::validation("room id is required"));
    }
    if message_id <= 0 {
        return Err(ChatError::validation("message id must be positive"));
    }
    let pool = app_ctx.pool.clone();
    let room_slug = room.to_string();
    let conn = web::block(move || pool.get())
        .await
        .map_err(|err| ChatError::internal("DB worker failure.", format!("{err:?}")))?
        .map_err(|err| ChatError::internal("Failed to acquire DB connection.", format!("{err:?}")))?;
    ensure_foreign_keys(&conn)
        .map_err(|err| ChatError::internal("Failed to enable foreign keys.", format!("{err:?}")))?;
    let affected = conn
        .execute(
            format!(
                "DELETE FROM {CHAT_MESSAGES_TABLE}
                 WHERE id = ?1 AND room_id = (SELECT id FROM {CHAT_ROOMS_TABLE} WHERE slug = ?2 LIMIT 1)"
            )
            .as_str(),
            (message_id, room_slug),
        )
        .map_err(|err| ChatError::internal("Failed to delete message.", format!("{err:?}")))?;
    Ok(affected > 0)
}

pub async fn get_recent_messages(
    app_ctx: &web::Data<AppCtx>,
    room_slug: &str,
    limit: Option<usize>,
) -> ChatResult<Vec<ChatMessage>> {
    let room = room_slug.trim();
    if room.is_empty() {
        return Err(ChatError::validation("room id is required"));
    }
    let query_limit = limit.unwrap_or(HISTORY_LIMIT).max(1).min(HISTORY_LIMIT) as i64;
    let pool = app_ctx.pool.clone();
    let room_slug = room.to_string();
    let conn = web::block(move || pool.get())
        .await
        .map_err(|err| ChatError::internal("DB worker failure.", format!("{err:?}")))?
        .map_err(|err| ChatError::internal("Failed to acquire DB connection.", format!("{err:?}")))?;
    ensure_foreign_keys(&conn)
        .map_err(|err| ChatError::internal("Failed to enable foreign keys.", format!("{err:?}")))?;
    let mut stmt = conn
        .prepare(
            format!(
                "SELECT m.id, r.slug as room_id, m.sender_id, m.sender_name, m.body, datetime(m.created_at) as created_at
                FROM {CHAT_MESSAGES_TABLE} m
                JOIN {CHAT_ROOMS_TABLE} r ON r.id = m.room_id
                WHERE r.slug = ?1
                ORDER BY m.id DESC
                LIMIT ?2"
            )
            .as_str(),
        )
        .map_err(|err| ChatError::internal("Failed to prepare history query.", format!("{err:?}")))?;

    let mut rows: Vec<ChatMessage> = stmt
        .query_map((room_slug, query_limit), |row| {
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
        .map_err(|err| ChatError::internal("Failed to load history.", format!("{err:?}")))?;

    rows.reverse();
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use std::path::PathBuf;
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
        let conn = ctx.pool.get().expect("pool connection should be available");
        init_chat_schema(&conn).expect("chat schema should be initialized");
        ctx
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
                format!("SELECT COUNT(*) FROM {} WHERE slug = ?1", CHAT_ROOMS_TABLE).as_str(),
                ("general",),
                |row| row.get(0),
            )
            .expect("count query should succeed");
        assert_eq!(count, 1);
    }

    #[actix_web::test]
    async fn deletes_rooms_with_fewer_messages_first_when_storage_limit_exceeded() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "aaaaa").await.expect("first room create should succeed");
        create_room_if_not_exists(&ctx, "bbbbb").await.expect("second room create should succeed");
        create_room_if_not_exists(&ctx, "ccccc").await.expect("third room create should succeed");
        insert_message(&ctx, "bbbbb", "u1", "alice", "one")
            .await
            .expect("insert message one should succeed");
        insert_message(&ctx, "bbbbb", "u2", "bob", "two")
            .await
            .expect("insert message two should succeed");
        insert_message(&ctx, "ccccc", "u3", "carol", "one")
            .await
            .expect("insert message three should succeed");

        let conn = ctx.pool.get().expect("pool connection should be available");
        enforce_rooms_storage_limit(&conn, 5).expect("limit should be enforced");
        let mut stmt = conn
            .prepare(format!("SELECT slug FROM {CHAT_ROOMS_TABLE} ORDER BY created_at ASC, id ASC").as_str())
            .expect("prepare should succeed");
        let rows: Vec<String> = stmt
            .query_map((), |row| row.get(0))
            .and_then(Iterator::collect::<Result<Vec<_>, _>>)
            .expect("query should succeed");
        assert_eq!(rows, vec!["bbbbb".to_string()]);
    }

    #[actix_web::test]
    async fn insert_and_fetch_recent_messages() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "general").await.expect("room create should succeed");
        insert_message(&ctx, "general", "u1", "alice", "first").await.expect("insert first message should succeed");
        insert_message(&ctx, "general", "u2", "bob", "second").await.expect("insert second message should succeed");

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
        create_room_if_not_exists(&ctx, "general").await.expect("room create should succeed");

        let empty_result = insert_message(&ctx, "general", "u1", "alice", "   ").await;
        assert!(empty_result.is_err());

        let too_long = "x".repeat(MAX_MESSAGE_LEN + 1);
        let long_result = insert_message(&ctx, "general", "u1", "alice", too_long.as_str()).await;
        assert!(long_result.is_err());
    }

    #[actix_web::test]
    async fn deletes_oldest_messages_when_storage_limit_exceeded() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "general").await.expect("room create should succeed");
        insert_message(&ctx, "general", "u1", "alice", "aaaaa").await.expect("insert first should succeed");
        insert_message(&ctx, "general", "u2", "bob", "bbbbb").await.expect("insert second should succeed");
        insert_message(&ctx, "general", "u3", "carol", "ccccc").await.expect("insert third should succeed");

        let conn = ctx.pool.get().expect("pool connection should be available");
        enforce_messages_storage_limit(&conn, 10).expect("limit should be enforced");
        let mut stmt = conn
            .prepare(
                format!(
                    "SELECT m.body
                     FROM {CHAT_MESSAGES_TABLE} m
                     JOIN {CHAT_ROOMS_TABLE} r ON r.id = m.room_id
                     WHERE r.slug = ?1
                     ORDER BY m.id ASC"
                )
                .as_str(),
            )
            .expect("prepare should succeed");
        let rows: Vec<String> = stmt
            .query_map(("general",), |row| row.get(0))
            .and_then(Iterator::collect::<Result<Vec<_>, _>>)
            .expect("query should succeed");
        assert_eq!(rows, vec!["bbbbb".to_string(), "ccccc".to_string()]);
    }

    #[actix_web::test]
    async fn delete_message_by_id_removes_target_message() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "general").await.expect("room create should succeed");
        let inserted = insert_message(&ctx, "general", "u1", "alice", "to delete")
            .await
            .expect("insert should succeed");

        let deleted = delete_message_by_id(&ctx, "general", inserted.id)
            .await
            .expect("delete should succeed");
        assert!(deleted);

        let messages = get_recent_messages(&ctx, "general", Some(10))
            .await
            .expect("query should succeed");
        assert!(messages.is_empty());
    }

    #[actix_web::test]
    async fn delete_message_by_id_does_not_delete_message_from_other_room() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "room-a").await.expect("room-a create should succeed");
        create_room_if_not_exists(&ctx, "room-b").await.expect("room-b create should succeed");
        let inserted = insert_message(&ctx, "room-a", "u1", "alice", "protected")
            .await
            .expect("insert should succeed");

        let deleted = delete_message_by_id(&ctx, "room-b", inserted.id)
            .await
            .expect("delete should succeed");
        assert!(!deleted);

        let room_a_messages = get_recent_messages(&ctx, "room-a", Some(10))
            .await
            .expect("query should succeed");
        assert_eq!(room_a_messages.len(), 1);
        assert_eq!(room_a_messages[0].body, "protected");
    }

    #[actix_web::test]
    async fn deleting_room_cascades_messages() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "aaaaa").await.expect("room a create should succeed");
        create_room_if_not_exists(&ctx, "bbbbb").await.expect("room b create should succeed");
        insert_message(&ctx, "aaaaa", "u1", "alice", "gone")
            .await
            .expect("insert for room a should succeed");
        insert_message(&ctx, "bbbbb", "u2", "bob", "stay")
            .await
            .expect("insert for room b should succeed");

        let conn = ctx.pool.get().expect("pool connection should be available");
        ensure_foreign_keys(&conn).expect("foreign keys should be enabled");
        enforce_rooms_storage_limit(&conn, 5).expect("limit should be enforced");

        let room_a = get_recent_messages(&ctx, "aaaaa", Some(10))
            .await
            .expect("query should succeed");
        let room_b = get_recent_messages(&ctx, "bbbbb", Some(10))
            .await
            .expect("query should succeed");
        assert!(room_a.is_empty(), "messages for deleted room should be removed");
        assert_eq!(room_b.len(), 1);
        assert_eq!(room_b[0].body, "stay");
    }
}
