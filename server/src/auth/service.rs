use rand::RngCore;

use super::error::{AuthError, AuthResult};
use super::{MAX_ASCII_NICKNAME_LEN, TX_HASH_LEN, WALLET_ADDRESS_LEN};

/// Validate and normalize an EVM wallet address (`0x` + 40 hex chars) to lowercase.
pub fn normalize_wallet_address(raw: &str) -> AuthResult<String> {
    let trimmed = raw.trim();
    if trimmed.len() != WALLET_ADDRESS_LEN {
        return Err(AuthError::validation(
            "wallet address must be a 42-character 0x-prefixed hex string",
        ));
    }
    let Some(hex_part) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    else {
        return Err(AuthError::validation("wallet address must start with 0x"));
    };
    if !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AuthError::validation(
            "wallet address must contain only hexadecimal characters",
        ));
    }
    Ok(format!("0x{}", hex_part.to_ascii_lowercase()))
}

/// Validate and normalize an EVM transaction hash (`0x` + 64 hex chars) to lowercase.
pub fn normalize_tx_hash(raw: &str) -> AuthResult<String> {
    let trimmed = raw.trim();
    if trimmed.len() != TX_HASH_LEN {
        return Err(AuthError::validation(
            "transaction hash must be a 66-character 0x-prefixed hex string",
        ));
    }
    let Some(hex_part) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    else {
        return Err(AuthError::validation("transaction hash must start with 0x"));
    };
    if !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AuthError::validation(
            "transaction hash must contain only hexadecimal characters",
        ));
    }
    Ok(format!("0x{}", hex_part.to_ascii_lowercase()))
}

/// Validate a nickname restricted to `1..=32` lowercase ASCII characters (`a-z`, `0-9`, `_`, `-`).
/// Prevents Unicode homograph spoofing and whitespace ambiguity.
pub fn validate_ascii_nickname(raw: &str) -> AuthResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ASCII_NICKNAME_LEN {
        return Err(AuthError::validation(format!(
            "nickname must be between 1 and {MAX_ASCII_NICKNAME_LEN} ASCII characters"
        )));
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    {
        return Err(AuthError::validation(
            "nickname may only contain lowercase ASCII letters, digits, '_' or '-'",
        ));
    }
    Ok(trimmed.to_string())
}

fn random_hex(num_bytes: usize) -> String {
    let mut bytes = vec![0u8; num_bytes];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(num_bytes * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Generate a 128-bit (32 hex chars) single-use SIWE nonce.
pub fn generate_nonce() -> String {
    random_hex(16)
}

/// Generate a 256-bit (64 hex chars) session token.
pub fn generate_session_token() -> String {
    random_hex(32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_mixed_case_wallet_address() {
        let input = "  0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c ";
        let normalized = normalize_wallet_address(input).expect("valid wallet should normalize");
        assert_eq!(normalized, "0xeff121f128e0e64c0e64ae8eb6eb042a0e5aa81c");
    }

    #[test]
    fn rejects_invalid_wallet_addresses() {
        assert!(normalize_wallet_address("").is_err());
        assert!(normalize_wallet_address("0x1234").is_err());
        assert!(
            normalize_wallet_address("eff121f128e0e64c0e64ae8eb6eb042a0e5aa81c12").is_err(),
            "missing 0x prefix should fail"
        );
        assert!(
            normalize_wallet_address("0xZZZ121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c").is_err(),
            "non-hex chars should fail"
        );
    }

    #[test]
    fn normalizes_and_validates_tx_hash() {
        let raw = " 0XABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789 ";
        let normalized = normalize_tx_hash(raw).expect("valid tx hash should normalize");
        assert_eq!(
            normalized,
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
        assert!(normalize_tx_hash("0x1234").is_err());
        assert!(
            normalize_tx_hash("0xGGGGGG0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789")
                .is_err()
        );
    }

    #[test]
    fn validates_ascii_nickname_and_rejects_unicode_or_uppercase() {
        assert_eq!(
            validate_ascii_nickname("  alice_01-dev ").unwrap(),
            "alice_01-dev"
        );
        assert!(validate_ascii_nickname("").is_err());
        assert!(validate_ascii_nickname("   ").is_err());
        assert!(validate_ascii_nickname(&"a".repeat(33)).is_err());
        assert!(
            validate_ascii_nickname("Alice").is_err(),
            "uppercase should be rejected"
        );
        assert!(
            validate_ascii_nickname("аlice").is_err(),
            "Cyrillic lookalike 'а' should be rejected"
        );
        assert!(
            validate_ascii_nickname("alice bob").is_err(),
            "spaces inside nickname should be rejected"
        );
    }

    #[test]
    fn generates_unique_nonces_and_session_tokens() {
        let n1 = generate_nonce();
        let n2 = generate_nonce();
        assert_eq!(n1.len(), 32);
        assert_ne!(n1, n2);

        let s1 = generate_session_token();
        let s2 = generate_session_token();
        assert_eq!(s1.len(), 64);
        assert_ne!(s1, s2);
    }
}
