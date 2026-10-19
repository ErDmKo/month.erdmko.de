use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::error::{AuthError, AuthResult};
use super::service::{
    generate_nonce, generate_session_token, normalize_tx_hash, normalize_wallet_address,
    validate_ascii_nickname,
};

pub static AUTH_NONCES_TABLE: &str = "auth_nonces";
pub static AUTH_SESSIONS_TABLE: &str = "auth_sessions";
pub static WALLET_PROFILES_TABLE: &str = "wallet_profiles";
pub static CLAIMED_PAYMENTS_TABLE: &str = "claimed_payments";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuedNonce {
    pub nonce: String,
    pub wallet_address: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthSession {
    pub token: String,
    pub wallet_address: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletProfile {
    pub wallet_address: String,
    pub nickname: Option<String>,
    pub access_until: i64,
    pub has_active_access: bool,
}

pub fn init_auth_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute(
        format!(
            "CREATE TABLE IF NOT EXISTS {AUTH_NONCES_TABLE} (
                nonce TEXT PRIMARY KEY,
                wallet_address TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                consumed_at INTEGER
            )"
        )
        .as_str(),
        (),
    )?;

    conn.execute(
        format!(
            "CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires_at
             ON {AUTH_NONCES_TABLE}(expires_at)"
        )
        .as_str(),
        (),
    )?;

    conn.execute(
        format!(
            "CREATE TABLE IF NOT EXISTS {AUTH_SESSIONS_TABLE} (
                token TEXT PRIMARY KEY,
                wallet_address TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            )"
        )
        .as_str(),
        (),
    )?;

    conn.execute(
        format!(
            "CREATE INDEX IF NOT EXISTS idx_auth_sessions_wallet_expires
             ON {AUTH_SESSIONS_TABLE}(wallet_address, expires_at)"
        )
        .as_str(),
        (),
    )?;

    conn.execute(
        format!(
            "CREATE TABLE IF NOT EXISTS {WALLET_PROFILES_TABLE} (
                wallet_address TEXT PRIMARY KEY,
                nickname TEXT UNIQUE,
                access_until INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )"
        )
        .as_str(),
        (),
    )?;

    conn.execute(
        format!(
            "CREATE TABLE IF NOT EXISTS {CLAIMED_PAYMENTS_TABLE} (
                tx_hash TEXT PRIMARY KEY,
                wallet_address TEXT NOT NULL,
                amount_wei TEXT NOT NULL,
                claimed_at INTEGER NOT NULL
            )"
        )
        .as_str(),
        (),
    )?;

    Ok(())
}

/// Issue and persist a single-use SIWE challenge nonce for a wallet address.
pub fn issue_nonce(
    conn: &rusqlite::Connection,
    raw_wallet_address: &str,
    now_unix: i64,
    ttl_secs: i64,
) -> AuthResult<IssuedNonce> {
    if ttl_secs <= 0 {
        return Err(AuthError::validation("nonce TTL must be positive"));
    }
    let wallet_address = normalize_wallet_address(raw_wallet_address)?;
    let nonce = generate_nonce();
    let expires_at = now_unix + ttl_secs;

    conn.execute(
        format!(
            "INSERT INTO {AUTH_NONCES_TABLE} (nonce, wallet_address, created_at, expires_at, consumed_at)
             VALUES (?1, ?2, ?3, ?4, NULL)"
        )
        .as_str(),
        (&nonce, &wallet_address, now_unix, expires_at),
    )
    .map_err(|err| AuthError::internal("Failed to persist auth nonce.", format!("{err:?}")))?;

    Ok(IssuedNonce {
        nonce,
        wallet_address,
        created_at: now_unix,
        expires_at,
    })
}

/// Atomically consume a nonce if and only if it exists, belongs to `raw_wallet_address`,
/// has not yet been consumed, and has not expired (`expires_at > now_unix`).
pub fn consume_nonce(
    conn: &rusqlite::Connection,
    nonce: &str,
    raw_wallet_address: &str,
    now_unix: i64,
) -> AuthResult<bool> {
    let trimmed_nonce = nonce.trim();
    if trimmed_nonce.is_empty() {
        return Err(AuthError::validation("nonce is required"));
    }
    let wallet_address = normalize_wallet_address(raw_wallet_address)?;

    let affected = conn
        .execute(
            format!(
                "UPDATE {AUTH_NONCES_TABLE}
                 SET consumed_at = ?1
                 WHERE nonce = ?2
                   AND wallet_address = ?3
                   AND consumed_at IS NULL
                   AND expires_at > ?1"
            )
            .as_str(),
            (now_unix, trimmed_nonce, &wallet_address),
        )
        .map_err(|err| AuthError::internal("Failed to consume auth nonce.", format!("{err:?}")))?;

    Ok(affected == 1)
}

/// Create a persistent session for a verified wallet address.
pub fn create_session(
    conn: &rusqlite::Connection,
    raw_wallet_address: &str,
    now_unix: i64,
    ttl_secs: i64,
) -> AuthResult<AuthSession> {
    if ttl_secs <= 0 {
        return Err(AuthError::validation("session TTL must be positive"));
    }
    let wallet_address = normalize_wallet_address(raw_wallet_address)?;
    let token = generate_session_token();
    let expires_at = now_unix + ttl_secs;

    conn.execute(
        format!(
            "INSERT INTO {AUTH_SESSIONS_TABLE} (token, wallet_address, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4)"
        )
        .as_str(),
        (&token, &wallet_address, now_unix, expires_at),
    )
    .map_err(|err| AuthError::internal("Failed to create auth session.", format!("{err:?}")))?;

    Ok(AuthSession {
        token,
        wallet_address,
        created_at: now_unix,
        expires_at,
    })
}

/// Resolve an active session token to its normalized wallet address, or `None` if unknown/expired.
pub fn get_valid_session_wallet(
    conn: &rusqlite::Connection,
    token: &str,
    now_unix: i64,
) -> AuthResult<Option<String>> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let wallet: Option<String> = conn
        .query_row(
            format!(
                "SELECT wallet_address
                 FROM {AUTH_SESSIONS_TABLE}
                 WHERE token = ?1 AND expires_at > ?2"
            )
            .as_str(),
            (trimmed, now_unix),
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| AuthError::internal("Failed to query auth session.", format!("{err:?}")))?;

    Ok(wallet)
}

/// Revoke a session token on logout. Returns `true` if a session row was deleted.
pub fn revoke_session(conn: &rusqlite::Connection, token: &str) -> AuthResult<bool> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let deleted = conn
        .execute(
            format!("DELETE FROM {AUTH_SESSIONS_TABLE} WHERE token = ?1").as_str(),
            (trimmed,),
        )
        .map_err(|err| AuthError::internal("Failed to revoke auth session.", format!("{err:?}")))?;
    Ok(deleted > 0)
}

/// Delete expired or already-consumed nonces and expired sessions.
pub fn cleanup_expired_auth_records(
    conn: &rusqlite::Connection,
    now_unix: i64,
) -> AuthResult<(usize, usize)> {
    let deleted_nonces = conn
        .execute(
            format!(
                "DELETE FROM {AUTH_NONCES_TABLE}
                 WHERE expires_at <= ?1 OR consumed_at IS NOT NULL"
            )
            .as_str(),
            (now_unix,),
        )
        .map_err(|err| {
            AuthError::internal("Failed to clean up auth nonces.", format!("{err:?}"))
        })?;

    let deleted_sessions = conn
        .execute(
            format!("DELETE FROM {AUTH_SESSIONS_TABLE} WHERE expires_at <= ?1").as_str(),
            (now_unix,),
        )
        .map_err(|err| {
            AuthError::internal("Failed to clean up auth sessions.", format!("{err:?}"))
        })?;

    Ok((deleted_nonces, deleted_sessions))
}

/// Fetch a wallet's profile (nickname + paid access expiration). Returns default unpaid profile if not yet registered.
pub fn get_wallet_profile(
    conn: &rusqlite::Connection,
    raw_wallet_address: &str,
    now_unix: i64,
) -> AuthResult<WalletProfile> {
    let wallet_address = normalize_wallet_address(raw_wallet_address)?;

    let row: Option<(Option<String>, i64)> = conn
        .query_row(
            format!(
                "SELECT nickname, access_until
                 FROM {WALLET_PROFILES_TABLE}
                 WHERE wallet_address = ?1"
            )
            .as_str(),
            (&wallet_address,),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|err| {
            AuthError::internal("Failed to query wallet profile.", format!("{err:?}"))
        })?;

    match row {
        Some((nickname, access_until)) => Ok(WalletProfile {
            wallet_address,
            nickname,
            access_until,
            has_active_access: access_until > now_unix,
        }),
        None => Ok(WalletProfile {
            wallet_address,
            nickname: None,
            access_until: 0,
            has_active_access: false,
        }),
    }
}

/// Assign or update a wallet's unique normalized ASCII nickname (`[a-z0-9_-]{1,32}`).
/// Rejects with `NICKNAME_TAKEN` if another wallet already owns `nickname`.
pub fn set_wallet_nickname(
    conn: &rusqlite::Connection,
    raw_wallet_address: &str,
    raw_nickname: &str,
    now_unix: i64,
) -> AuthResult<WalletProfile> {
    let wallet_address = normalize_wallet_address(raw_wallet_address)?;
    let nickname = validate_ascii_nickname(raw_nickname)?;

    let existing_owner: Option<String> = conn
        .query_row(
            format!(
                "SELECT wallet_address
                 FROM {WALLET_PROFILES_TABLE}
                 WHERE nickname = ?1"
            )
            .as_str(),
            (&nickname,),
            |r| r.get(0),
        )
        .optional()
        .map_err(|err| {
            AuthError::internal("Failed to check nickname owner.", format!("{err:?}"))
        })?;

    if let Some(owner) = existing_owner {
        if owner != wallet_address {
            return Err(AuthError::conflict(
                "NICKNAME_TAKEN",
                "Nickname is already registered to another wallet.",
            ));
        }
    }

    conn.execute(
        format!(
            "INSERT INTO {WALLET_PROFILES_TABLE} (wallet_address, nickname, access_until, updated_at)
             VALUES (?1, ?2, 0, ?3)
             ON CONFLICT(wallet_address) DO UPDATE SET
                nickname = excluded.nickname,
                updated_at = excluded.updated_at"
        )
        .as_str(),
        (&wallet_address, &nickname, now_unix),
    )
    .map_err(|err| AuthError::internal("Failed to update wallet nickname.", format!("{err:?}")))?;

    get_wallet_profile(conn, &wallet_address, now_unix)
}

/// Record a verified ETH payment transaction hash and extend the wallet's `access_until`
/// by `duration_secs` (stacking on top of `MAX(access_until, now_unix)`).
/// Rejects replayed `tx_hash` values with `PAYMENT_ALREADY_CLAIMED`.
pub fn record_payment_and_extend_access(
    conn: &rusqlite::Connection,
    raw_wallet_address: &str,
    raw_tx_hash: &str,
    amount_wei: &str,
    now_unix: i64,
    duration_secs: i64,
) -> AuthResult<WalletProfile> {
    if duration_secs <= 0 {
        return Err(AuthError::validation("access duration must be positive"));
    }
    let wallet_address = normalize_wallet_address(raw_wallet_address)?;
    let tx_hash = normalize_tx_hash(raw_tx_hash)?;
    let trimmed_amount = amount_wei.trim();
    if trimmed_amount.is_empty() {
        return Err(AuthError::validation("amount_wei is required"));
    }

    let inserted = conn
        .execute(
            format!(
                "INSERT OR IGNORE INTO {CLAIMED_PAYMENTS_TABLE} (tx_hash, wallet_address, amount_wei, claimed_at)
                 VALUES (?1, ?2, ?3, ?4)"
            )
            .as_str(),
            (&tx_hash, &wallet_address, trimmed_amount, now_unix),
        )
        .map_err(|err| AuthError::internal("Failed to record claimed payment.", format!("{err:?}")))?;

    if inserted == 0 {
        return Err(AuthError::conflict(
            "PAYMENT_ALREADY_CLAIMED",
            "This transaction hash has already been claimed.",
        ));
    }

    conn.execute(
        format!(
            "INSERT INTO {WALLET_PROFILES_TABLE} (wallet_address, nickname, access_until, updated_at)
             VALUES (?1, NULL, ?2 + ?3, ?2)
             ON CONFLICT(wallet_address) DO UPDATE SET
                access_until = MAX({WALLET_PROFILES_TABLE}.access_until, ?2) + ?3,
                updated_at = ?2"
        )
        .as_str(),
        (&wallet_address, now_unix, duration_secs),
    )
    .map_err(|err| AuthError::internal("Failed to extend wallet access.", format!("{err:?}")))?;

    get_wallet_profile(conn, &wallet_address, now_unix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{DEFAULT_ACCESS_DURATION_SECS, NONCE_TTL_SECS, SESSION_TTL_SECS};

    const ALICE_WALLET_MIXED: &str = "0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c";
    const ALICE_WALLET_LOWER: &str = "0xeff121f128e0e64c0e64ae8eb6eb042a0e5aa81c";
    const BOB_WALLET_MIXED: &str = "0x1111111111111111111111111111111111111111";
    const SAMPLE_TX_1: &str = "0xAAAA000000000000000000000000000000000000000000000000000000000001";
    const SAMPLE_TX_2: &str = "0xBBBB000000000000000000000000000000000000000000000000000000000002";

    fn setup_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory sqlite should open");
        init_auth_schema(&conn).expect("auth schema should initialize");
        conn
    }

    #[test]
    fn nonce_is_single_use_and_bound_to_wallet() {
        let conn = setup_conn();
        let now = 1_700_000_000;
        let issued = issue_nonce(&conn, ALICE_WALLET_MIXED, now, NONCE_TTL_SECS)
            .expect("nonce should be issued");
        assert_eq!(issued.wallet_address, ALICE_WALLET_LOWER);
        assert_eq!(issued.expires_at, now + NONCE_TTL_SECS);

        // Wrong wallet cannot consume Alice's nonce
        let wrong_wallet = consume_nonce(&conn, &issued.nonce, BOB_WALLET_MIXED, now + 10)
            .expect("consume_nonce should not error");
        assert!(!wrong_wallet, "wrong wallet must not consume nonce");

        // First valid consumption succeeds (case-insensitive wallet input)
        let first_try = consume_nonce(&conn, &issued.nonce, ALICE_WALLET_LOWER, now + 10)
            .expect("consume_nonce should succeed");
        assert!(first_try, "first consumption should succeed");

        // Replay attempt is rejected
        let replay_try = consume_nonce(&conn, &issued.nonce, ALICE_WALLET_MIXED, now + 11)
            .expect("replay check should not error");
        assert!(!replay_try, "replayed nonce must be rejected");
    }

    #[test]
    fn expired_nonce_cannot_be_consumed() {
        let conn = setup_conn();
        let now = 1_700_000_000;
        let issued = issue_nonce(&conn, ALICE_WALLET_MIXED, now, 60).expect("nonce issued");

        let at_expiry = consume_nonce(&conn, &issued.nonce, ALICE_WALLET_MIXED, now + 60)
            .expect("consume at expiry should not error");
        assert!(!at_expiry, "nonce at exact expiration timestamp must fail");
    }

    #[test]
    fn session_lifecycle_create_lookup_expire_and_revoke() {
        let conn = setup_conn();
        let now = 1_700_000_000;
        let session = create_session(&conn, ALICE_WALLET_MIXED, now, SESSION_TTL_SECS)
            .expect("session should be created");
        assert_eq!(session.wallet_address, ALICE_WALLET_LOWER);

        // Valid before expiration
        let resolved = get_valid_session_wallet(&conn, &session.token, now + 3600)
            .expect("lookup should succeed");
        assert_eq!(resolved.as_deref(), Some(ALICE_WALLET_LOWER));

        // Expired session returns None
        let expired = get_valid_session_wallet(&conn, &session.token, now + SESSION_TTL_SECS)
            .expect("lookup at expiry should succeed");
        assert!(expired.is_none(), "expired session must not resolve");

        // Revoke active session
        let revoked = revoke_session(&conn, &session.token).expect("revoke should succeed");
        assert!(revoked);
        let after_revoke = get_valid_session_wallet(&conn, &session.token, now + 10)
            .expect("lookup after revoke should succeed");
        assert!(after_revoke.is_none());
    }

    #[test]
    fn cleanup_removes_consumed_and_expired_records_only() {
        let conn = setup_conn();
        let now = 1_700_000_000;

        let consumed_nonce = issue_nonce(&conn, ALICE_WALLET_MIXED, now, 300).unwrap();
        assert!(consume_nonce(&conn, &consumed_nonce.nonce, ALICE_WALLET_MIXED, now + 1).unwrap());

        let expired_nonce = issue_nonce(&conn, ALICE_WALLET_MIXED, now, 10).unwrap();
        let active_nonce = issue_nonce(&conn, ALICE_WALLET_MIXED, now, 300).unwrap();

        let expired_session = create_session(&conn, ALICE_WALLET_MIXED, now, 20).unwrap();
        let active_session = create_session(&conn, BOB_WALLET_MIXED, now, 300).unwrap();

        let (deleted_nonces, deleted_sessions) =
            cleanup_expired_auth_records(&conn, now + 50).expect("cleanup should succeed");
        assert_eq!(deleted_nonces, 2);
        assert_eq!(deleted_sessions, 1);

        // Expired nonce is gone, active nonce still consumable
        assert!(!consume_nonce(&conn, &expired_nonce.nonce, ALICE_WALLET_MIXED, now + 5).unwrap());
        assert!(consume_nonce(&conn, &active_nonce.nonce, ALICE_WALLET_MIXED, now + 50).unwrap());

        // Expired session is gone, active session still valid
        assert!(
            get_valid_session_wallet(&conn, &expired_session.token, now + 5)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            get_valid_session_wallet(&conn, &active_session.token, now + 50)
                .unwrap()
                .as_deref(),
            Some(BOB_WALLET_MIXED)
        );
    }

    #[test]
    fn nickname_uniqueness_and_owner_update() {
        let conn = setup_conn();
        let now = 1_700_000_000;

        let profile = set_wallet_nickname(&conn, ALICE_WALLET_MIXED, "alice", now)
            .expect("Alice should claim nickname");
        assert_eq!(profile.nickname.as_deref(), Some("alice"));
        assert!(!profile.has_active_access);

        // Bob cannot claim "alice"
        let bob_err = set_wallet_nickname(&conn, BOB_WALLET_MIXED, "alice", now + 1)
            .expect_err("Bob must not claim Alice's nickname");
        assert_eq!(bob_err.code(), "NICKNAME_TAKEN");

        // Alice can re-save or change her own nickname, freeing "alice"
        let updated = set_wallet_nickname(&conn, ALICE_WALLET_MIXED, "alice_new", now + 2)
            .expect("Alice can change nickname");
        assert_eq!(updated.nickname.as_deref(), Some("alice_new"));

        let bob_claimed = set_wallet_nickname(&conn, BOB_WALLET_MIXED, "alice", now + 3)
            .expect("Bob can claim 'alice' once released");
        assert_eq!(bob_claimed.nickname.as_deref(), Some("alice"));
    }

    #[test]
    fn payment_extends_access_stacks_duration_and_rejects_replay() {
        let conn = setup_conn();
        let now = 1_700_000_000;

        let p1 = record_payment_and_extend_access(
            &conn,
            ALICE_WALLET_MIXED,
            SAMPLE_TX_1,
            "1000000000000000",
            now,
            DEFAULT_ACCESS_DURATION_SECS,
        )
        .expect("first payment claim should succeed");
        assert!(p1.has_active_access);
        assert_eq!(p1.access_until, now + DEFAULT_ACCESS_DURATION_SECS);

        // Replaying the same tx_hash is rejected
        let replay = record_payment_and_extend_access(
            &conn,
            BOB_WALLET_MIXED,
            SAMPLE_TX_1,
            "1000000000000000",
            now + 10,
            DEFAULT_ACCESS_DURATION_SECS,
        )
        .expect_err("duplicate tx_hash must fail");
        assert_eq!(replay.code(), "PAYMENT_ALREADY_CLAIMED");

        // Second distinct payment while access is still active stacks on top of current access_until
        let p2 = record_payment_and_extend_access(
            &conn,
            ALICE_WALLET_MIXED,
            SAMPLE_TX_2,
            "1000000000000000",
            now + 100,
            DEFAULT_ACCESS_DURATION_SECS,
        )
        .expect("second payment should stack");
        assert_eq!(p2.access_until, now + DEFAULT_ACCESS_DURATION_SECS * 2);
    }
}
