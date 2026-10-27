use chrono::DateTime;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use super::db::consume_nonce;
use super::error::{AuthError, AuthResult};
use super::service::normalize_wallet_address;

pub const DEFAULT_SIWE_DOMAIN: &str = "erdmko.dev";
pub const SIWE_VERSION: &str = "1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiweMessage {
    pub domain: String,
    pub address: String,
    pub statement: Option<String>,
    pub uri: String,
    pub version: String,
    pub chain_id: u64,
    pub nonce: String,
    pub issued_at: String,
    pub expiration_time: Option<String>,
    pub not_before: Option<String>,
    pub request_id: Option<String>,
}

/// Format an EIP-4361 Sign-In with Ethereum message.
pub fn format_siwe_message(msg: &SiweMessage) -> String {
    let mut out = format!(
        "{} wants you to sign in with your Ethereum account:\n{}\n\n",
        msg.domain, msg.address
    );
    if let Some(statement) = &msg.statement {
        if !statement.is_empty() {
            out.push_str(statement);
            out.push_str("\n\n");
        }
    }
    out.push_str(&format!(
        "URI: {}\nVersion: {}\nChain ID: {}\nNonce: {}\nIssued At: {}",
        msg.uri, msg.version, msg.chain_id, msg.nonce, msg.issued_at
    ));
    if let Some(exp) = &msg.expiration_time {
        out.push_str(&format!("\nExpiration Time: {exp}"));
    }
    if let Some(nbf) = &msg.not_before {
        out.push_str(&format!("\nNot Before: {nbf}"));
    }
    if let Some(req_id) = &msg.request_id {
        out.push_str(&format!("\nRequest ID: {req_id}"));
    }
    out
}

/// Parse an EIP-4361 message into structured fields and normalize its wallet address.
pub fn parse_siwe_message(raw: &str) -> AuthResult<SiweMessage> {
    let normalized_newlines = raw.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized_newlines.lines().collect();
    if lines.len() < 7 {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_MESSAGE",
            "SIWE message is incomplete.",
        ));
    }

    const HEADER_SUFFIX: &str = " wants you to sign in with your Ethereum account:";
    let Some(domain) = lines[0].strip_suffix(HEADER_SUFFIX) else {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_MESSAGE",
            "SIWE message header is invalid.",
        ));
    };
    let domain = domain.trim();
    if domain.is_empty() || domain.chars().any(char::is_whitespace) {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_MESSAGE",
            "SIWE domain is invalid.",
        ));
    }

    let address = normalize_wallet_address(lines[1]).map_err(|_| {
        AuthError::unauthorized("INVALID_SIWE_MESSAGE", "SIWE wallet address is invalid.")
    })?;

    if !lines[2].is_empty() {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_MESSAGE",
            "Expected empty line after SIWE wallet address.",
        ));
    }

    let mut idx = 3;
    let statement = if lines.get(idx).is_some_and(|l| l.starts_with("URI: ")) {
        None
    } else {
        let mut stmt_lines = Vec::new();
        while idx < lines.len() && !lines[idx].is_empty() && !lines[idx].starts_with("URI: ") {
            stmt_lines.push(lines[idx]);
            idx += 1;
        }
        if idx >= lines.len() || !lines[idx].is_empty() {
            return Err(AuthError::unauthorized(
                "INVALID_SIWE_MESSAGE",
                "Expected blank line after SIWE statement.",
            ));
        }
        idx += 1;
        if stmt_lines.is_empty() {
            None
        } else {
            Some(stmt_lines.join("\n"))
        }
    };

    let uri = strip_field(lines.get(idx).copied(), "URI: ")?;
    idx += 1;
    let version = strip_field(lines.get(idx).copied(), "Version: ")?;
    idx += 1;
    let chain_id_raw = strip_field(lines.get(idx).copied(), "Chain ID: ")?;
    let chain_id = chain_id_raw.parse::<u64>().map_err(|_| {
        AuthError::unauthorized("INVALID_SIWE_MESSAGE", "SIWE Chain ID must be an integer.")
    })?;
    idx += 1;
    let nonce = strip_field(lines.get(idx).copied(), "Nonce: ")?;
    idx += 1;
    let issued_at = strip_field(lines.get(idx).copied(), "Issued At: ")?;
    idx += 1;

    let mut expiration_time = None;
    let mut not_before = None;
    let mut request_id = None;

    while idx < lines.len() {
        let line = lines[idx];
        if let Some(val) = line.strip_prefix("Expiration Time: ") {
            if expiration_time.is_some() {
                return Err(AuthError::unauthorized(
                    "INVALID_SIWE_MESSAGE",
                    "Duplicate Expiration Time field.",
                ));
            }
            expiration_time = Some(val.trim().to_string());
        } else if let Some(val) = line.strip_prefix("Not Before: ") {
            if not_before.is_some() {
                return Err(AuthError::unauthorized(
                    "INVALID_SIWE_MESSAGE",
                    "Duplicate Not Before field.",
                ));
            }
            not_before = Some(val.trim().to_string());
        } else if let Some(val) = line.strip_prefix("Request ID: ") {
            if request_id.is_some() {
                return Err(AuthError::unauthorized(
                    "INVALID_SIWE_MESSAGE",
                    "Duplicate Request ID field.",
                ));
            }
            request_id = Some(val.trim().to_string());
        } else {
            return Err(AuthError::unauthorized(
                "INVALID_SIWE_MESSAGE",
                "Unexpected field in SIWE message.",
            ));
        }
        idx += 1;
    }

    Ok(SiweMessage {
        domain: domain.to_string(),
        address,
        statement,
        uri,
        version,
        chain_id,
        nonce,
        issued_at,
        expiration_time,
        not_before,
        request_id,
    })
}

fn strip_field(line: Option<&str>, prefix: &str) -> AuthResult<String> {
    let Some(line) = line else {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_MESSAGE",
            format!("Missing required SIWE field '{prefix}'"),
        ));
    };
    let Some(val) = line.strip_prefix(prefix) else {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_MESSAGE",
            format!("Expected SIWE field '{prefix}'"),
        ));
    };
    let trimmed = val.trim();
    if trimmed.is_empty() {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_MESSAGE",
            format!("SIWE field '{prefix}' cannot be empty"),
        ));
    }
    Ok(trimmed.to_string())
}

/// Check whether a SIWE domain matches the configured server domain or localhost in dev.
pub fn is_allowed_siwe_domain(domain: &str) -> bool {
    let normalized = domain.trim().to_ascii_lowercase();
    if let Ok(env_domain) = std::env::var("DOMAIN") {
        let env_norm = env_domain.trim().to_ascii_lowercase();
        if !env_norm.is_empty() && normalized == env_norm {
            return true;
        }
    }
    if let Some(compile_domain) = option_env!("DOMAIN") {
        if normalized == compile_domain.to_ascii_lowercase() {
            return true;
        }
    }
    matches!(
        normalized.as_str(),
        "erdmko.dev" | "erdmko.dev:443" | "localhost" | "localhost:8080"
    ) || normalized.starts_with("127.0.0.1:")
}

/// Validate parsed SIWE fields (domain, version, chain ID, URI, nonce format, and timestamps).
pub fn validate_siwe_message(
    msg: &SiweMessage,
    expected_domain: Option<&str>,
    expected_chain_id: Option<u64>,
    now_unix: i64,
) -> AuthResult<()> {
    if let Some(expected) = expected_domain {
        if !msg.domain.eq_ignore_ascii_case(expected.trim()) {
            return Err(AuthError::unauthorized(
                "SIWE_DOMAIN_MISMATCH",
                "SIWE domain does not match expected domain.",
            ));
        }
    }
    if !is_allowed_siwe_domain(&msg.domain) {
        return Err(AuthError::unauthorized(
            "SIWE_DOMAIN_MISMATCH",
            "SIWE domain is not allowed.",
        ));
    }
    if msg.version != SIWE_VERSION {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_VERSION",
            "SIWE Version must be '1'.",
        ));
    }
    if msg.chain_id == 0 {
        return Err(AuthError::unauthorized(
            "INVALID_CHAIN_ID",
            "SIWE Chain ID must be positive.",
        ));
    }
    if let Some(expected_cid) = expected_chain_id {
        if msg.chain_id != expected_cid {
            return Err(AuthError::unauthorized(
                "CHAIN_ID_MISMATCH",
                "SIWE Chain ID does not match expected chain.",
            ));
        }
    }
    if !(msg.uri.starts_with("http://") || msg.uri.starts_with("https://")) {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_URI",
            "SIWE URI must use http or https scheme.",
        ));
    }
    if msg.nonce.len() < 8 || !msg.nonce.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AuthError::unauthorized(
            "INVALID_NONCE",
            "SIWE nonce must be at least 8 ASCII alphanumeric characters.",
        ));
    }

    let issued_dt = DateTime::parse_from_rfc3339(&msg.issued_at).map_err(|_| {
        AuthError::unauthorized(
            "INVALID_SIWE_TIMESTAMP",
            "SIWE Issued At must be a valid RFC 3339 timestamp.",
        )
    })?;
    if issued_dt.timestamp() > now_unix + 300 {
        return Err(AuthError::unauthorized(
            "INVALID_SIWE_TIMESTAMP",
            "SIWE Issued At timestamp is in the future.",
        ));
    }

    if let Some(exp_str) = &msg.expiration_time {
        let exp_dt = DateTime::parse_from_rfc3339(exp_str).map_err(|_| {
            AuthError::unauthorized(
                "INVALID_SIWE_TIMESTAMP",
                "SIWE Expiration Time must be a valid RFC 3339 timestamp.",
            )
        })?;
        if exp_dt.timestamp() <= now_unix {
            return Err(AuthError::unauthorized(
                "SIWE_EXPIRED",
                "SIWE challenge has expired.",
            ));
        }
    }

    if let Some(nbf_str) = &msg.not_before {
        let nbf_dt = DateTime::parse_from_rfc3339(nbf_str).map_err(|_| {
            AuthError::unauthorized(
                "INVALID_SIWE_TIMESTAMP",
                "SIWE Not Before must be a valid RFC 3339 timestamp.",
            )
        })?;
        if nbf_dt.timestamp() > now_unix {
            return Err(AuthError::unauthorized(
                "SIWE_NOT_YET_VALID",
                "SIWE challenge is not yet valid.",
            ));
        }
    }

    Ok(())
}

/// Compute the Keccak-256 digest of `data` using the `sha3` crate.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// Compute the EIP-191 `personal_sign` digest:
/// `keccak256("\x19Ethereum Signed Message:\n" + message.len() + message)`
pub fn eip191_message_digest(message: &str) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut hasher = Keccak256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(message.as_bytes());
    hasher.finalize().into()
}

/// Recover the normalized (`0x` + 40 lowercase hex) Ethereum wallet address from an
/// EIP-191 `personal_sign` message and 65-byte `(r, s, v)` hex signature.
pub fn recover_personal_sign_address(message: &str, signature_hex: &str) -> AuthResult<String> {
    let sig_bytes = parse_signature_bytes(signature_hex)?;
    let digest = eip191_message_digest(message);
    recover_address_from_digest(&digest, &sig_bytes)
}

/// Verify an EIP-4361 message and its `personal_sign` signature without touching SQLite.
pub fn verify_siwe_signature(
    raw_message: &str,
    raw_signature: &str,
    expected_domain: Option<&str>,
    expected_chain_id: Option<u64>,
    now_unix: i64,
) -> AuthResult<SiweMessage> {
    let parsed = parse_siwe_message(raw_message)?;
    validate_siwe_message(&parsed, expected_domain, expected_chain_id, now_unix)?;
    let recovered = recover_personal_sign_address(raw_message, raw_signature)?;
    if recovered != parsed.address {
        return Err(AuthError::unauthorized(
            "INVALID_SIGNATURE",
            "Recovered signer does not match SIWE wallet address.",
        ));
    }
    Ok(parsed)
}

/// Full SIWE verification: parse + validate EIP-4361 fields, verify `personal_sign` signature,
/// and atomically consume the single-use nonce in SQLite.
pub fn verify_siwe_and_consume_nonce(
    conn: &Connection,
    raw_message: &str,
    raw_signature: &str,
    expected_domain: Option<&str>,
    expected_chain_id: Option<u64>,
    now_unix: i64,
) -> AuthResult<SiweMessage> {
    let parsed = verify_siwe_signature(
        raw_message,
        raw_signature,
        expected_domain,
        expected_chain_id,
        now_unix,
    )?;
    let consumed = consume_nonce(conn, &parsed.nonce, &parsed.address, now_unix)?;
    if !consumed {
        return Err(AuthError::unauthorized(
            "INVALID_NONCE",
            "SIWE nonce is invalid, expired, or has already been used.",
        ));
    }
    Ok(parsed)
}

fn parse_signature_bytes(raw_signature: &str) -> AuthResult<[u8; 65]> {
    let trimmed = raw_signature.trim();
    let hex_part = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .ok_or_else(|| {
            AuthError::unauthorized("INVALID_SIGNATURE", "Signature must start with 0x.")
        })?;
    if hex_part.len() != 130 {
        return Err(AuthError::unauthorized(
            "INVALID_SIGNATURE",
            "Signature must be a 65-byte (130 hex char) 0x-prefixed string.",
        ));
    }
    let decoded = hex::decode(hex_part).map_err(|_| {
        AuthError::unauthorized("INVALID_SIGNATURE", "Signature contains non-hex characters.")
    })?;
    decoded.try_into().map_err(|_| {
        AuthError::unauthorized("INVALID_SIGNATURE", "Signature must be exactly 65 bytes.")
    })
}

fn recover_address_from_digest(digest: &[u8; 32], sig: &[u8; 65]) -> AuthResult<String> {
    let signature = Signature::from_slice(&sig[..64]).map_err(|_| {
        AuthError::unauthorized("INVALID_SIGNATURE", "Invalid secp256k1 signature.")
    })?;

    // EIP-2: reject malleable high-s signatures
    if signature.normalize_s().is_some() {
        return Err(AuthError::unauthorized(
            "INVALID_SIGNATURE",
            "Signature s value is malleable (must be low-s).",
        ));
    }

    let rec_byte = match sig[64] {
        0 | 1 => sig[64],
        27 | 28 => sig[64] - 27,
        _ => {
            return Err(AuthError::unauthorized(
                "INVALID_SIGNATURE",
                "Invalid recovery ID in signature.",
            ));
        }
    };
    let recovery_id = RecoveryId::try_from(rec_byte).map_err(|_| {
        AuthError::unauthorized("INVALID_SIGNATURE", "Invalid recovery ID in signature.")
    })?;

    let verifying_key = VerifyingKey::recover_from_prehash(digest, &signature, recovery_id)
        .map_err(|_| {
            AuthError::unauthorized(
                "INVALID_SIGNATURE",
                "Failed to recover public key from signature.",
            )
        })?;

    Ok(verifying_key_to_address(&verifying_key))
}

fn verifying_key_to_address(verifying_key: &VerifyingKey) -> String {
    let encoded = verifying_key.to_encoded_point(false);
    let uncompressed_xy = &encoded.as_bytes()[1..]; // skip 0x04 SEC1 prefix
    let hash = keccak256(uncompressed_xy);
    format!("0x{}", hex::encode(&hash[12..]))
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::*;
    use k256::ecdsa::SigningKey;

    /// Derive the normalized (`0x` + 40 lowercase hex) Ethereum address for a 32-byte private key.
    pub fn wallet_address_from_private_key(priv_key_bytes: &[u8; 32]) -> String {
        let signing_key =
            SigningKey::from_bytes(priv_key_bytes.into()).expect("valid private key");
        verifying_key_to_address(signing_key.verifying_key())
    }

    /// Deterministically sign an EIP-191 `personal_sign` message with a 32-byte private key,
    /// returning a `0x`-prefixed 65-byte `(r, s, v)` hex signature (`v` in `{27, 28}`).
    pub fn sign_personal_message(priv_key_bytes: &[u8; 32], message: &str) -> String {
        let signing_key =
            SigningKey::from_bytes(priv_key_bytes.into()).expect("valid private key");
        let digest = eip191_message_digest(message);
        let (signature, recovery_id) = signing_key
            .sign_prehash_recoverable(&digest)
            .expect("signing should succeed");

        let mut sig = [0u8; 65];
        sig[..64].copy_from_slice(&signature.to_bytes());
        sig[64] = recovery_id.to_byte() + 27;
        format!("0x{}", hex::encode(sig))
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::{sign_personal_message, wallet_address_from_private_key};
    use super::*;
    use crate::auth::NONCE_TTL_SECS;
    use crate::auth::db::{init_auth_schema, issue_nonce};

    const PRIV_KEY_1: [u8; 32] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 1,
    ];
    const PRIV_KEY_2: [u8; 32] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 2,
    ];
    // Known Ethereum address for private key = 1
    const KNOWN_ADDR_KEY_1: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

    fn sample_siwe_message(address: &str, nonce: &str) -> SiweMessage {
        SiweMessage {
            domain: "erdmko.dev".to_string(),
            address: address.to_string(),
            statement: Some("Sign in to month.erdmko.de chat.".to_string()),
            uri: "https://erdmko.dev/chat/general".to_string(),
            version: "1".to_string(),
            chain_id: 1,
            nonce: nonce.to_string(),
            issued_at: "2026-10-20T12:00:00Z".to_string(),
            expiration_time: Some("2026-10-20T12:05:00Z".to_string()),
            not_before: None,
            request_id: None,
        }
    }

    #[test]
    fn keccak256_matches_known_vectors() {
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        assert_eq!(
            hex::encode(keccak256(b"abc")),
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
    }

    #[test]
    fn derives_known_ethereum_address_and_recovers_personal_sign() {
        let derived = wallet_address_from_private_key(&PRIV_KEY_1);
        assert_eq!(derived, KNOWN_ADDR_KEY_1);

        let msg = format_siwe_message(&sample_siwe_message(&derived, "abcdef0123456789"));
        let sig = sign_personal_message(&PRIV_KEY_1, &msg);
        let recovered =
            recover_personal_sign_address(&msg, &sig).expect("ecrecover should succeed");
        assert_eq!(recovered, KNOWN_ADDR_KEY_1);
    }

    #[test]
    fn rejects_wrong_domain_wrong_chain_expired_tampered_or_mismatched_signature() {
        let addr1 = wallet_address_from_private_key(&PRIV_KEY_1);
        let now_unix = 1_792_497_700; // 2026-10-20T12:01:40Z (between issued_at and expiration_time)
        let msg_struct = sample_siwe_message(&addr1, "abcdef0123456789");
        let raw_msg = format_siwe_message(&msg_struct);
        let sig = sign_personal_message(&PRIV_KEY_1, &raw_msg);

        // Valid verification succeeds
        let ok = verify_siwe_signature(&raw_msg, &sig, Some("erdmko.dev"), Some(1), now_unix)
            .expect("valid SIWE message and signature should pass");
        assert_eq!(ok.address, addr1);

        // Wrong expected domain rejected
        let wrong_domain =
            verify_siwe_signature(&raw_msg, &sig, Some("evil.example"), Some(1), now_unix)
                .expect_err("wrong domain must fail");
        assert_eq!(wrong_domain.code(), "SIWE_DOMAIN_MISMATCH");

        // Wrong chain ID rejected
        let wrong_chain =
            verify_siwe_signature(&raw_msg, &sig, Some("erdmko.dev"), Some(8453), now_unix)
                .expect_err("wrong chain ID must fail");
        assert_eq!(wrong_chain.code(), "CHAIN_ID_MISMATCH");

        // Expired challenge rejected
        let expired = verify_siwe_signature(
            &raw_msg,
            &sig,
            Some("erdmko.dev"),
            Some(1),
            1_792_498_000, // after 12:05:00Z
        )
        .expect_err("expired challenge must fail");
        assert_eq!(expired.code(), "SIWE_EXPIRED");

        // Tampered message rejected
        let tampered_msg = raw_msg.replace("general", "admin");
        let tampered =
            verify_siwe_signature(&tampered_msg, &sig, Some("erdmko.dev"), Some(1), now_unix)
                .expect_err("tampered message must fail");
        assert_eq!(tampered.code(), "INVALID_SIGNATURE");

        // Signed by a different wallet (PRIV_KEY_2) rejected
        let sig_from_key_2 = sign_personal_message(&PRIV_KEY_2, &raw_msg);
        let mismatched = verify_siwe_signature(
            &raw_msg,
            &sig_from_key_2,
            Some("erdmko.dev"),
            Some(1),
            now_unix,
        )
        .expect_err("signature from another wallet must fail");
        assert_eq!(mismatched.code(), "INVALID_SIGNATURE");
    }

    #[test]
    fn consumes_single_use_nonce_and_rejects_replay() {
        let conn = Connection::open_in_memory().unwrap();
        init_auth_schema(&conn).unwrap();
        let now_unix = 1_792_497_700;
        let addr1 = wallet_address_from_private_key(&PRIV_KEY_1);

        let issued = issue_nonce(&conn, &addr1, now_unix, NONCE_TTL_SECS).unwrap();
        let msg_struct = sample_siwe_message(&addr1, &issued.nonce);
        let raw_msg = format_siwe_message(&msg_struct);
        let sig = sign_personal_message(&PRIV_KEY_1, &raw_msg);

        let verified = verify_siwe_and_consume_nonce(
            &conn,
            &raw_msg,
            &sig,
            Some("erdmko.dev"),
            Some(1),
            now_unix + 5,
        )
        .expect("first verification with valid nonce should succeed");
        assert_eq!(verified.address, addr1);

        let replay = verify_siwe_and_consume_nonce(
            &conn,
            &raw_msg,
            &sig,
            Some("erdmko.dev"),
            Some(1),
            now_unix + 6,
        )
        .expect_err("replaying consumed nonce must fail");
        assert_eq!(replay.code(), "INVALID_NONCE");
    }
}
