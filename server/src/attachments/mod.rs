pub mod db;
pub mod error;
pub mod service;

pub const MAX_ATTACHMENT_SIZE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_ATTACHMENTS_STORAGE_BYTES: usize = 1024 * 1024 * 1024;
pub const ATTACHMENT_CHUNK_SIZE: usize = 64 * 1024;
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;
pub const MAX_PENDING_UPLOADS_PER_SESSION: usize = 3;
pub const PENDING_UPLOAD_TTL: std::time::Duration = std::time::Duration::from_secs(300);
