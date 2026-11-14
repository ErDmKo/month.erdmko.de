use crate::generated::telemetry::TelemetryEvent;

use super::sink::{
    TelemetryRecord, decode_event_name, decode_kind, decode_op, decode_providers, decode_severity,
};

pub const MAX_CODE_CHARS: usize = 64;
pub const MAX_PATH_CHARS: usize = 128;
pub const MAX_MESSAGE_CHARS: usize = 256;
const MAX_FUTURE_SKEW_MS: u64 = 86_400_000; // 24 hours
const MIN_SECRET_HEX_DIGITS: usize = 64;

fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

pub fn sanitize_code(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|ch| !ch.is_control()).collect();
    truncate_chars(cleaned.trim(), MAX_CODE_CHARS)
}

pub fn sanitize_path(raw: &str) -> String {
    let without_query_or_hash = raw.split(['?', '#']).next().unwrap_or("");
    let cleaned: String = without_query_or_hash
        .chars()
        .filter(|ch| !ch.is_control())
        .collect();
    truncate_chars(cleaned.trim(), MAX_PATH_CHARS)
}

fn normalize_control_chars(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.chars() {
        if matches!(ch, '\r' | '\n' | '\t' | ' ') {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else if !ch.is_control() {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

fn redact_session_cookie(input: &str) -> String {
    const NEEDLE: &str = "month_session=";
    let lower = input.to_ascii_lowercase();
    if !lower.contains(NEEDLE) {
        return input.to_string();
    }

    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find(NEEDLE) {
        let start = cursor + rel;
        out.push_str(&input[cursor..start]);
        out.push_str("month_session=[REDACTED]");
        let val_start = start + NEEDLE.len();
        let val_len = input[val_start..]
            .find(|c: char| c.is_whitespace() || matches!(c, ';' | '"' | '\'' | '&' | ','))
            .unwrap_or(input.len() - val_start);
        cursor = val_start + val_len;
    }
    out.push_str(&input[cursor..]);
    out
}

fn redact_long_hex_secrets(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;

    while i < bytes.len() {
        let has_0x = i + 2 < bytes.len()
            && bytes[i] == b'0'
            && (bytes[i + 1] == b'x' || bytes[i + 1] == b'X')
            && bytes[i + 2].is_ascii_hexdigit()
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric());

        let hex_start = if has_0x { i + 2 } else { i };
        let at_word_boundary = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();

        if at_word_boundary && hex_start < bytes.len() && bytes[hex_start].is_ascii_hexdigit() {
            let mut end = hex_start;
            while end < bytes.len() && bytes[end].is_ascii_hexdigit() {
                end += 1;
            }
            let ends_at_boundary = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
            let hex_len = end - hex_start;
            if ends_at_boundary && hex_len >= MIN_SECRET_HEX_DIGITS {
                out.push_str("[REDACTED_HEX]");
                i = end;
                continue;
            }
        }

        let ch = input[i..].chars().next().expect("valid utf-8 slice");
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

pub fn sanitize_message(raw: &str) -> String {
    let single_line = normalize_control_chars(raw);
    let without_cookie = redact_session_cookie(&single_line);
    let without_hex = redact_long_hex_secrets(&without_cookie);
    truncate_chars(&without_hex, MAX_MESSAGE_CHARS)
}

pub fn clamp_client_timestamp_ms(client_ts: u64, observed_ts_ms: i64) -> u64 {
    if client_ts == 0 {
        return 0;
    }
    let max_allowed = (observed_ts_ms.max(0) as u64).saturating_add(MAX_FUTURE_SKEW_MS);
    client_ts.min(max_allowed)
}

pub fn build_record(event: &TelemetryEvent, observed_timestamp_ms: i64) -> TelemetryRecord {
    let (severity_number, severity_text) = decode_severity(event.severity, event.kind);
    TelemetryRecord {
        observed_timestamp_ms,
        client_timestamp_ms: clamp_client_timestamp_ms(event.timestamp_ms, observed_timestamp_ms),
        severity_number,
        severity_text,
        event_name: decode_event_name(severity_number),
        kind: decode_kind(event.kind),
        op: decode_op(event.op),
        code: sanitize_code(&event.code),
        message: sanitize_message(&event.message),
        path: sanitize_path(&event.path),
        line: event.line,
        column: event.column,
        chain_id: event.chain_id,
        providers: decode_providers(event.provider_flags),
    }
}
