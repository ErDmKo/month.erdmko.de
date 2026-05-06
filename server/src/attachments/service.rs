use std::collections::HashMap;
use std::time::Instant;

use actix_web::web;
use serde_json::json;

use crate::app::AppCtx;
use crate::attachments::db::{
    AttachmentMeta, enforce_attachments_storage_limit, get_attachment_data, insert_attachment,
};
use crate::attachments::{
    ATTACHMENT_CHUNK_SIZE, MAX_ATTACHMENTS_STORAGE_BYTES, MAX_PENDING_UPLOADS_PER_SESSION,
    PENDING_UPLOAD_TTL,
};
use crate::chat::service::now_iso;

// ── Pending upload state ──────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PendingUpload {
    pub upload_id: u32,
    pub message_id: i64,
    pub filename: String,
    pub size: usize,
    pub mime_type: String,
    pub chunks: Vec<Vec<u8>>,
    pub next_index: u32,
    pub last_activity: Instant,
}

impl PendingUpload {
    pub fn new(
        upload_id: u32,
        message_id: i64,
        filename: String,
        size: usize,
        mime_type: String,
    ) -> Self {
        Self {
            upload_id,
            message_id,
            filename,
            size,
            mime_type,
            chunks: Vec::new(),
            next_index: 0,
            last_activity: Instant::now(),
        }
    }

    pub fn accumulated_size(&self) -> usize {
        self.chunks.iter().map(|c| c.len()).sum()
    }

    pub fn is_expired(&self) -> bool {
        self.last_activity.elapsed() > PENDING_UPLOAD_TTL
    }
}

// ── Session state ─────────────────────────────────────────────────────────────

pub struct UploadSessionState {
    pending: HashMap<u32, PendingUpload>,
    next_id: u32,
}

impl UploadSessionState {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            next_id: 1,
        }
    }

    fn purge_expired(&mut self) {
        self.pending.retain(|_, v| !v.is_expired());
    }

    pub fn start_upload(
        &mut self,
        message_id: i64,
        filename: String,
        size: usize,
        mime_type: String,
    ) -> Result<u32, &'static str> {
        self.purge_expired();
        if self.pending.len() >= MAX_PENDING_UPLOADS_PER_SESSION {
            return Err("UPLOAD_LIMIT_EXCEEDED");
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.pending.insert(
            id,
            PendingUpload::new(id, message_id, filename, size, mime_type),
        );
        Ok(id)
    }

    pub fn add_chunk(
        &mut self,
        upload_id: u32,
        index: u32,
        data: Vec<u8>,
    ) -> Result<(), &'static str> {
        self.purge_expired();
        let pending = self.pending.get_mut(&upload_id).ok_or("UPLOAD_NOT_FOUND")?;

        if pending.is_expired() {
            self.pending.remove(&upload_id);
            return Err("UPLOAD_EXPIRED");
        }
        if index != pending.next_index {
            return Err("UPLOAD_CHUNK_OUT_OF_ORDER");
        }
        if pending.accumulated_size() + data.len() > pending.size {
            return Err("UPLOAD_TOO_LARGE");
        }
        pending.chunks.push(data);
        pending.next_index += 1;
        pending.last_activity = Instant::now();
        Ok(())
    }

    /// Consume the pending upload. Returns the assembled bytes on success.
    pub fn finish_upload(&mut self, upload_id: u32) -> Result<PendingUpload, &'static str> {
        self.purge_expired();
        let pending = self.pending.get(&upload_id).ok_or("UPLOAD_NOT_FOUND")?;

        if pending.is_expired() {
            self.pending.remove(&upload_id);
            return Err("UPLOAD_EXPIRED");
        }

        let expected_full = pending.size;
        let received = pending.accumulated_size();
        if received != expected_full {
            return Err("UPLOAD_INCOMPLETE");
        }

        Ok(self.pending.remove(&upload_id).unwrap())
    }
}

// ── Payload builders ──────────────────────────────────────────────────────────

pub fn upload_ready_payload(request_id: Option<&str>, upload_id: u32) -> String {
    json!({
        "type": "upload_ready",
        "requestId": request_id,
        "uploadId": upload_id,
        "ts": now_iso(),
    })
    .to_string()
}

pub fn upload_done_payload(
    request_id: Option<&str>,
    upload_id: u32,
    meta: &AttachmentMeta,
) -> String {
    json!({
        "type": "upload_done",
        "requestId": request_id,
        "uploadId": upload_id,
        "attachment": {
            "id": meta.id,
            "messageId": meta.message_id,
            "filename": meta.filename,
            "size": meta.size,
            "mimeType": meta.mime_type,
        },
        "ts": now_iso(),
    })
    .to_string()
}

pub fn download_start_payload(
    request_id: Option<&str>,
    meta: &AttachmentMeta,
    total_chunks: usize,
) -> String {
    json!({
        "type": "download_start",
        "requestId": request_id,
        "attachmentId": meta.id,
        "filename": meta.filename,
        "size": meta.size,
        "mimeType": meta.mime_type,
        "totalChunks": total_chunks,
        "ts": now_iso(),
    })
    .to_string()
}

pub fn download_end_payload(request_id: Option<&str>, attachment_id: i64) -> String {
    json!({
        "type": "download_end",
        "requestId": request_id,
        "attachmentId": attachment_id,
        "ts": now_iso(),
    })
    .to_string()
}

// ── Protobuf encode/decode ────────────────────────────────────────────────────

use assets_proto::assets::{DownloadChunk, UploadChunk};
use prost::Message;

/// Encode a `DownloadChunk` to protobuf binary.
pub fn encode_download_chunk(attachment_id: i64, index: u32, data: &[u8]) -> Vec<u8> {
    DownloadChunk {
        attachment_id: attachment_id.to_string(),
        index,
        data: data.to_vec(),
    }
    .encode_to_vec()
}

/// Decode an `UploadChunk` from protobuf binary.
pub fn decode_upload_chunk(buf: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let msg = UploadChunk::decode(buf).ok()?;
    Some((msg.upload_id, msg.index, msg.data))
}

// ── DB-level upload/download ops ──────────────────────────────────────────────

pub async fn persist_upload(
    app_ctx: &web::Data<AppCtx>,
    pending: PendingUpload,
) -> rusqlite::Result<AttachmentMeta> {
    let pool = app_ctx.pool.clone();
    web::block(move || {
        let conn = pool
            .get()
            .map_err(|e| rusqlite::Error::InvalidParameterName(format!("pool error: {e:?}")))?;
        conn.execute("PRAGMA foreign_keys = ON", ())
            .map_err(|e| e)?;
        let data: Vec<u8> = pending.chunks.into_iter().flatten().collect();
        let att = insert_attachment(
            &conn,
            pending.message_id,
            &pending.filename,
            data.len() as i64,
            &pending.mime_type,
            &data,
        )?;
        enforce_attachments_storage_limit(&conn, MAX_ATTACHMENTS_STORAGE_BYTES)?;
        Ok(att.meta)
    })
    .await
    .map_err(|e| rusqlite::Error::InvalidParameterName(format!("block error: {e:?}")))?
}

pub async fn load_attachment_for_download(
    app_ctx: &web::Data<AppCtx>,
    attachment_id: i64,
    room_slug: &str,
) -> rusqlite::Result<Option<(AttachmentMeta, Vec<u8>)>> {
    let pool = app_ctx.pool.clone();
    let room_slug = room_slug.to_string();
    web::block(move || {
        let conn = pool
            .get()
            .map_err(|e| rusqlite::Error::InvalidParameterName(format!("pool error: {e:?}")))?;
        get_attachment_data(&conn, attachment_id, &room_slug)
    })
    .await
    .map_err(|e| rusqlite::Error::InvalidParameterName(format!("block error: {e:?}")))?
}

/// Split a blob into 64 KB chunks for streaming.
pub fn split_into_chunks(data: &[u8]) -> Vec<&[u8]> {
    data.chunks(ATTACHMENT_CHUNK_SIZE).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_session_happy_path() {
        let mut state = UploadSessionState::new();
        let id = state
            .start_upload(1, "f.txt".into(), 10, "text/plain".into())
            .unwrap();
        state.add_chunk(id, 0, vec![1u8; 5]).unwrap();
        state.add_chunk(id, 1, vec![2u8; 5]).unwrap();
        let pending = state.finish_upload(id).unwrap();
        let data: Vec<u8> = pending.chunks.into_iter().flatten().collect();
        assert_eq!(data, [vec![1u8; 5], vec![2u8; 5]].concat());
    }

    #[test]
    fn upload_session_out_of_order() {
        let mut state = UploadSessionState::new();
        let id = state
            .start_upload(1, "f.txt".into(), 10, "text/plain".into())
            .unwrap();
        let err = state.add_chunk(id, 1, vec![0u8; 5]).unwrap_err();
        assert_eq!(err, "UPLOAD_CHUNK_OUT_OF_ORDER");
    }

    #[test]
    fn upload_session_unknown_id() {
        let mut state = UploadSessionState::new();
        let err = state.add_chunk(999, 0, vec![0u8; 5]).unwrap_err();
        assert_eq!(err, "UPLOAD_NOT_FOUND");
    }

    #[test]
    fn upload_session_limit_exceeded() {
        let mut state = UploadSessionState::new();
        for _ in 0..MAX_PENDING_UPLOADS_PER_SESSION {
            state
                .start_upload(1, "f.txt".into(), 5, "text/plain".into())
                .unwrap();
        }
        let err = state
            .start_upload(1, "f.txt".into(), 5, "text/plain".into())
            .unwrap_err();
        assert_eq!(err, "UPLOAD_LIMIT_EXCEEDED");
    }

    #[test]
    fn upload_session_incomplete() {
        let mut state = UploadSessionState::new();
        let id = state
            .start_upload(1, "f.txt".into(), 10, "text/plain".into())
            .unwrap();
        state.add_chunk(id, 0, vec![1u8; 5]).unwrap();
        // only 5 bytes sent, declared 10
        let err = state.finish_upload(id).unwrap_err();
        assert_eq!(err, "UPLOAD_INCOMPLETE");
    }

    #[test]
    fn upload_session_too_large() {
        let mut state = UploadSessionState::new();
        let id = state
            .start_upload(1, "f.txt".into(), 5, "text/plain".into())
            .unwrap();
        state.add_chunk(id, 0, vec![1u8; 5]).unwrap();
        // attempt to add more than declared
        let err = state.add_chunk(id, 1, vec![1u8]).unwrap_err();
        assert_eq!(err, "UPLOAD_TOO_LARGE");
    }

    #[test]
    fn encode_decode_upload_chunk_roundtrip() {
        use assets_proto::assets::UploadChunk;
        use prost::Message;

        let upload_id: u32 = 42;
        let index: u32 = 7;
        let data = b"hello proto";

        let buf = UploadChunk {
            upload_id,
            index,
            data: data.to_vec(),
        }
        .encode_to_vec();

        let (got_id, got_index, got_data) = decode_upload_chunk(&buf).unwrap();
        assert_eq!(got_id, upload_id);
        assert_eq!(got_index, index);
        assert_eq!(got_data, data);
    }

    #[test]
    fn encode_download_chunk_produces_valid_proto() {
        use assets_proto::assets::DownloadChunk;
        use prost::Message;

        let encoded = encode_download_chunk(99, 3, b"world");
        let decoded = DownloadChunk::decode(encoded.as_slice()).unwrap();
        assert_eq!(decoded.attachment_id, "99");
        assert_eq!(decoded.index, 3);
        assert_eq!(decoded.data, b"world");
    }

    #[test]
    fn split_into_chunks_correct_sizes() {
        let data = vec![0u8; ATTACHMENT_CHUNK_SIZE * 2 + 100];
        let chunks = split_into_chunks(&data);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), ATTACHMENT_CHUNK_SIZE);
        assert_eq!(chunks[1].len(), ATTACHMENT_CHUNK_SIZE);
        assert_eq!(chunks[2].len(), 100);
    }
}
