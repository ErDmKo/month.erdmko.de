pub mod db;
pub mod error;
pub mod service;

pub const WALLET_ADDRESS_LEN: usize = 42;
pub const MAX_ASCII_NICKNAME_LEN: usize = 32;
pub const NONCE_TTL_SECS: i64 = 300;
pub const SESSION_TTL_SECS: i64 = 7 * 24 * 60 * 60;
