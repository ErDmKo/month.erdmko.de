use rusqlite;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::chat::db::{CHAT_MESSAGES_TABLE, CHAT_ROOMS_TABLE};

pub static ATTACHMENTS_TABLE: &str = "attachments";

// ── Models ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub id: i64,
    pub message_id: i64,
    pub filename: String,
    pub size: i64,
    pub mime_type: String,
    pub created_at: String,
}

// Full record including blob data — only used internally for downloads.
pub struct Attachment {
    pub meta: AttachmentMeta,
    pub data: Vec<u8>,
}

// ── Schema ────────────────────────────────────────────────────────────────────

pub fn init_attachments_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute(
        format!(
            "CREATE TABLE IF NOT EXISTS {ATTACHMENTS_TABLE} (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id  INTEGER NOT NULL,
                filename    TEXT    NOT NULL,
                size        INTEGER NOT NULL,
                mime_type   TEXT    NOT NULL,
                data        BLOB    NOT NULL,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(message_id) REFERENCES {CHAT_MESSAGES_TABLE}(id) ON DELETE CASCADE
            )"
        )
        .as_str(),
        (),
    )?;

    conn.execute(
        format!(
            "CREATE INDEX IF NOT EXISTS idx_attachments_message_id
             ON {ATTACHMENTS_TABLE}(message_id)"
        )
        .as_str(),
        (),
    )?;

    Ok(())
}

// ── Data access ───────────────────────────────────────────────────────────────

/// Insert a new attachment and return its full record.
pub fn insert_attachment(
    conn: &rusqlite::Connection,
    message_id: i64,
    filename: &str,
    size: i64,
    mime_type: &str,
    data: &[u8],
) -> rusqlite::Result<Attachment> {
    conn.execute(
        format!(
            "INSERT INTO {ATTACHMENTS_TABLE} (message_id, filename, size, mime_type, data)
             VALUES (?1, ?2, ?3, ?4, ?5)"
        )
        .as_str(),
        rusqlite::params![message_id, filename, size, mime_type, data],
    )?;
    let id = conn.last_insert_rowid();
    let meta = conn.query_row(
        format!(
            "SELECT id, message_id, filename, size, mime_type, datetime(created_at) as created_at
             FROM {ATTACHMENTS_TABLE}
             WHERE id = ?1"
        )
        .as_str(),
        (id,),
        row_to_meta,
    )?;
    Ok(Attachment {
        data: data.to_vec(),
        meta,
    })
}

/// Return metadata (no blob) for all attachments of a single message.
pub fn get_attachments_for_message(
    conn: &rusqlite::Connection,
    message_id: i64,
) -> rusqlite::Result<Vec<AttachmentMeta>> {
    let mut stmt = conn.prepare(
        format!(
            "SELECT id, message_id, filename, size, mime_type, datetime(created_at) as created_at
             FROM {ATTACHMENTS_TABLE}
             WHERE message_id = ?1
             ORDER BY id ASC"
        )
        .as_str(),
    )?;
    stmt.query_map((message_id,), row_to_meta)
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
}

/// Return metadata + blob for a single attachment, verifying it belongs to the given room.
pub fn get_attachment_data(
    conn: &rusqlite::Connection,
    attachment_id: i64,
    room_slug: &str,
) -> rusqlite::Result<Option<(AttachmentMeta, Vec<u8>)>> {
    let result = conn.query_row(
        format!(
            "SELECT a.id, a.message_id, a.filename, a.size, a.mime_type,
                    datetime(a.created_at) as created_at, a.data
             FROM {ATTACHMENTS_TABLE} a
             JOIN {CHAT_MESSAGES_TABLE} m ON m.id = a.message_id
             JOIN {CHAT_ROOMS_TABLE} r    ON r.id = m.room_id
             WHERE a.id = ?1 AND r.slug = ?2"
        )
        .as_str(),
        rusqlite::params![attachment_id, room_slug],
        |row| {
            let meta = AttachmentMeta {
                id: row.get("id")?,
                message_id: row.get("message_id")?,
                filename: row.get("filename")?,
                size: row.get("size")?,
                mime_type: row.get("mime_type")?,
                created_at: row.get("created_at")?,
            };
            let data: Vec<u8> = row.get("data")?;
            Ok((meta, data))
        },
    );

    match result {
        Ok(pair) => Ok(Some(pair)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Batch-fetch metadata for a set of message IDs; returns a map message_id → attachments.
pub fn get_attachments_for_messages(
    conn: &rusqlite::Connection,
    message_ids: &[i64],
) -> rusqlite::Result<HashMap<i64, Vec<AttachmentMeta>>> {
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }

    // Build a parameterised IN clause dynamically.
    let placeholders = message_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "SELECT id, message_id, filename, size, mime_type, datetime(created_at) as created_at
         FROM {ATTACHMENTS_TABLE}
         WHERE message_id IN ({placeholders})
         ORDER BY id ASC"
    );

    let mut stmt = conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(message_ids.iter());
    let rows: Vec<AttachmentMeta> = stmt
        .query_map(params, row_to_meta)
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)?;

    let mut map: HashMap<i64, Vec<AttachmentMeta>> = HashMap::new();
    for meta in rows {
        map.entry(meta.message_id).or_default().push(meta);
    }
    Ok(map)
}

/// Delete oldest attachments (by created_at ASC, id ASC) until total stored size ≤ max_bytes.
pub fn enforce_attachments_storage_limit(
    conn: &rusqlite::Connection,
    max_bytes: usize,
) -> rusqlite::Result<()> {
    let max_bytes = max_bytes as i64;
    loop {
        let current_total: i64 = conn.query_row(
            format!("SELECT COALESCE(SUM(size), 0) FROM {ATTACHMENTS_TABLE}").as_str(),
            (),
            |row| row.get(0),
        )?;
        if current_total <= max_bytes {
            return Ok(());
        }
        let deleted = conn.execute(
            format!(
                "DELETE FROM {ATTACHMENTS_TABLE}
                 WHERE id IN (
                     SELECT id FROM {ATTACHMENTS_TABLE}
                     ORDER BY created_at ASC, id ASC
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

// ── Helpers ───────────────────────────────────────────────────────────────────

fn row_to_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentMeta> {
    Ok(AttachmentMeta {
        id: row.get("id")?,
        message_id: row.get("message_id")?,
        filename: row.get("filename")?,
        size: row.get("size")?,
        mime_type: row.get("mime_type")?,
        created_at: row.get("created_at")?,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{AppCtx, Pool};
    use crate::chat::db::{create_room_if_not_exists, init_chat_schema, insert_message};
    use actix_web::web;
    use r2d2_sqlite::SqliteConnectionManager;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_db_path() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("month_attach_db_{nanos}.sqlite"));
        p
    }

    fn setup_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(unique_db_path()).unwrap();
        conn.execute("PRAGMA foreign_keys = ON", ()).unwrap();
        init_chat_schema(&conn).unwrap();
        init_attachments_schema(&conn).unwrap();
        conn
    }

    fn setup_ctx() -> web::Data<AppCtx> {
        let manager = SqliteConnectionManager::file(unique_db_path());
        let pool = Pool::new(manager).unwrap();
        let ctx = web::Data::new(AppCtx {
            static_path: PathBuf::new(),
            pool,
        });
        let conn = ctx.pool.get().unwrap();
        conn.execute("PRAGMA foreign_keys = ON", ()).unwrap();
        init_chat_schema(&conn).unwrap();
        init_attachments_schema(&conn).unwrap();
        ctx
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// Insert a room + message and return the message id.
    async fn seed_message(ctx: &web::Data<AppCtx>, room: &str) -> i64 {
        create_room_if_not_exists(ctx, room).await.unwrap();
        insert_message(ctx, room, "u1", "alice", "hello")
            .await
            .unwrap()
            .id
    }

    // ── 1. Migration test ─────────────────────────────────────────────────────
    #[test]
    fn migration_creates_table_and_index() {
        let conn = setup_conn();
        // Table exists
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                (ATTACHMENTS_TABLE,),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "attachments table should exist");

        // Index exists
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_attachments_message_id'",
                (),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1, "idx_attachments_message_id should exist");
    }

    // ── 2. Insert test ────────────────────────────────────────────────────────
    #[actix_web::test]
    async fn insert_stores_all_fields() {
        let ctx = setup_ctx();
        let msg_id = seed_message(&ctx, "general").await;
        let conn = ctx.pool.get().unwrap();

        let att = insert_attachment(&conn, msg_id, "photo.jpg", 42, "image/jpeg", b"deadbeef")
            .unwrap();

        assert_eq!(att.meta.message_id, msg_id);
        assert_eq!(att.meta.filename, "photo.jpg");
        assert_eq!(att.meta.size, 42);
        assert_eq!(att.meta.mime_type, "image/jpeg");
        assert_eq!(att.data, b"deadbeef");
        assert!(att.meta.id > 0);
    }

    // ── 3. Fetch test ─────────────────────────────────────────────────────────
    #[actix_web::test]
    async fn get_attachments_for_message_returns_meta_without_data() {
        let ctx = setup_ctx();
        let msg_id = seed_message(&ctx, "general").await;
        let conn = ctx.pool.get().unwrap();

        insert_attachment(&conn, msg_id, "a.txt", 10, "text/plain", b"hello").unwrap();
        insert_attachment(&conn, msg_id, "b.txt", 20, "text/plain", b"world").unwrap();

        let metas = get_attachments_for_message(&conn, msg_id).unwrap();
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].filename, "a.txt");
        assert_eq!(metas[1].filename, "b.txt");
        // Data column not exposed
    }

    // ── 4. Data test ──────────────────────────────────────────────────────────
    #[actix_web::test]
    async fn get_attachment_data_returns_blob_for_correct_room() {
        let ctx = setup_ctx();
        let msg_id = seed_message(&ctx, "general").await;
        let conn = ctx.pool.get().unwrap();

        let att = insert_attachment(&conn, msg_id, "file.bin", 4, "application/octet-stream", b"\x01\x02\x03\x04").unwrap();

        let result = get_attachment_data(&conn, att.meta.id, "general").unwrap();
        assert!(result.is_some());
        let (meta, data) = result.unwrap();
        assert_eq!(meta.id, att.meta.id);
        assert_eq!(data, b"\x01\x02\x03\x04");
    }

    // ── 5. Cascade test ───────────────────────────────────────────────────────
    #[actix_web::test]
    async fn deleting_message_cascades_to_attachments() {
        let ctx = setup_ctx();
        let msg_id = seed_message(&ctx, "general").await;
        let conn = ctx.pool.get().unwrap();

        let att = insert_attachment(&conn, msg_id, "x.jpg", 5, "image/jpeg", b"bytes").unwrap();

        // Delete the message directly
        conn.execute(
            format!("DELETE FROM {CHAT_MESSAGES_TABLE} WHERE id = ?1").as_str(),
            (msg_id,),
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                format!("SELECT COUNT(*) FROM {ATTACHMENTS_TABLE} WHERE id = ?1").as_str(),
                (att.meta.id,),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "attachment should be deleted via CASCADE");
    }

    // ── 6. Room scope test ────────────────────────────────────────────────────
    #[actix_web::test]
    async fn get_attachment_data_rejects_wrong_room() {
        let ctx = setup_ctx();
        let msg_id = seed_message(&ctx, "room-a").await;
        let conn = ctx.pool.get().unwrap();

        let att = insert_attachment(&conn, msg_id, "secret.txt", 3, "text/plain", b"abc").unwrap();

        let result = get_attachment_data(&conn, att.meta.id, "room-b").unwrap();
        assert!(result.is_none(), "should not return attachment from another room");
    }

    // ── 7. Storage limit test ─────────────────────────────────────────────────
    #[actix_web::test]
    async fn enforce_storage_limit_removes_oldest_first() {
        let ctx = setup_ctx();
        let msg_id = seed_message(&ctx, "general").await;
        let conn = ctx.pool.get().unwrap();

        // Three attachments with size 10 each (total 30)
        let a1 = insert_attachment(&conn, msg_id, "a.bin", 10, "application/octet-stream", &[0u8; 10]).unwrap();
        let a2 = insert_attachment(&conn, msg_id, "b.bin", 10, "application/octet-stream", &[0u8; 10]).unwrap();
        let _a3 = insert_attachment(&conn, msg_id, "c.bin", 10, "application/octet-stream", &[0u8; 10]).unwrap();

        // Limit to 15 bytes → oldest two should be removed, newest survives
        enforce_attachments_storage_limit(&conn, 15).unwrap();

        let remaining: Vec<i64> = {
            let mut stmt = conn
                .prepare(
                    format!("SELECT id FROM {ATTACHMENTS_TABLE} ORDER BY id ASC").as_str(),
                )
                .unwrap();
            stmt.query_map((), |r| r.get(0))
                .and_then(Iterator::collect::<Result<Vec<_>, _>>)
                .unwrap()
        };

        assert!(!remaining.contains(&a1.meta.id), "oldest should be removed");
        assert!(!remaining.contains(&a2.meta.id), "second oldest should be removed");
    }

    // ── 8. Batch test ─────────────────────────────────────────────────────────
    #[actix_web::test]
    async fn get_attachments_for_messages_groups_by_message_id() {
        let ctx = setup_ctx();
        create_room_if_not_exists(&ctx, "general").await.unwrap();
        let m1 = insert_message(&ctx, "general", "u1", "alice", "msg1").await.unwrap().id;
        let m2 = insert_message(&ctx, "general", "u2", "bob", "msg2").await.unwrap().id;
        let conn = ctx.pool.get().unwrap();

        insert_attachment(&conn, m1, "a.txt", 1, "text/plain", b"a").unwrap();
        insert_attachment(&conn, m1, "b.txt", 1, "text/plain", b"b").unwrap();
        insert_attachment(&conn, m2, "c.txt", 1, "text/plain", b"c").unwrap();

        let map = get_attachments_for_messages(&conn, &[m1, m2]).unwrap();

        assert_eq!(map[&m1].len(), 2);
        assert_eq!(map[&m2].len(), 1);
        assert_eq!(map[&m1][0].filename, "a.txt");
        assert_eq!(map[&m2][0].filename, "c.txt");
    }
}
