pub mod db;
pub mod error;
pub mod service;
pub mod siwe;

pub const SESSION_COOKIE_NAME: &str = "month_session";
pub const RECIPIENT_WALLET_ADDRESS: &str = "0xeff121f128e0e64c0e64ae8eb6eb042a0e5aa81c";
pub const WALLET_ADDRESS_LEN: usize = 42;
pub const TX_HASH_LEN: usize = 66;
pub const MAX_ASCII_NICKNAME_LEN: usize = 32;
pub const NONCE_TTL_SECS: i64 = 300;
pub const SESSION_TTL_SECS: i64 = 7 * 24 * 60 * 60;
pub const DEFAULT_ACCESS_DURATION_SECS: i64 = 30 * 24 * 60 * 60;
