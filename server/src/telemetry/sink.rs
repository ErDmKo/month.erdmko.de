use chrono::{TimeZone, Utc};
use std::io::{self, Write};

use crate::generated::telemetry::{
    TelemetryKind, TelemetryOp, TelemetryProviderFlag, TelemetrySeverity,
};

pub const OTEL_SEVERITY_TRACE: u8 = 1;
pub const OTEL_SEVERITY_DEBUG: u8 = 5;
pub const OTEL_SEVERITY_INFO: u8 = 9;
pub const OTEL_SEVERITY_WARN: u8 = 13;
pub const OTEL_SEVERITY_ERROR: u8 = 17;
pub const OTEL_SEVERITY_FATAL: u8 = 21;

pub const OTEL_EVENT_BROWSER_ERROR: &str = "browser.error";
pub const OTEL_EVENT_BROWSER_LOG: &str = "browser.log";

/// Sanitized client telemetry record aligned with the OpenTelemetry Logs Data Model
/// (`SeverityNumber` 1..=24 + `SeverityText` TRACE/DEBUG/INFO/WARN/ERROR/FATAL).
///
/// Keeping decoding and semantic field names behind [`TelemetrySink`] allows
/// plugging in `opentelemetry_sdk` / `opentelemetry-otlp` later without
/// changing the wire schema or WebSocket handler.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelemetryRecord {
    pub observed_timestamp_ms: i64,
    pub client_timestamp_ms: u64,
    pub severity_number: u8,
    pub severity_text: &'static str,
    pub event_name: &'static str,
    pub kind: &'static str,
    pub op: &'static str,
    pub code: String,
    pub message: String,
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub chain_id: u64,
    pub providers: String,
}

pub trait TelemetrySink: Send + Sync + 'static {
    fn emit(&self, record: &TelemetryRecord);
}

/// Default production consumer: writes structured single-line telemetry records
/// directly to `stdout` (so `docker logs <app> | grep telemetry` and stdout log
/// shippers capture them without needing `stderr` redirection).
pub struct StdoutTelemetrySink;

impl StdoutTelemetrySink {
    pub fn write_record<W: Write>(out: &mut W, record: &TelemetryRecord) -> io::Result<()> {
        let observed_iso = Utc
            .timestamp_millis_opt(record.observed_timestamp_ms)
            .single()
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_else(|| record.observed_timestamp_ms.to_string());

        writeln!(
            out,
            "[{observed_iso} {:<5} telemetry] event={} severity={} kind={} op={} code={:?} chain_id={} providers={} path={:?} loc={}:{} client_ts={} msg={:?}",
            record.severity_text,
            record.event_name,
            record.severity_number,
            record.kind,
            record.op,
            record.code,
            record.chain_id,
            record.providers,
            record.path,
            record.line,
            record.column,
            record.client_timestamp_ms,
            record.message,
        )
    }
}

impl TelemetrySink for StdoutTelemetrySink {
    fn emit(&self, record: &TelemetryRecord) {
        let stdout = io::stdout();
        let mut handle = stdout.lock();
        let _ = Self::write_record(&mut handle, record);
        let _ = handle.flush();
    }
}

/// Resolves `(severity_number, severity_text)` according to the OpenTelemetry
/// Logs Data Model. When `raw_severity` is `UNSPECIFIED (0)`, falls back to a
/// sensible default based on `TelemetryKind`.
pub fn decode_severity(raw_severity: i32, raw_kind: i32) -> (u8, &'static str) {
    match TelemetrySeverity::try_from(raw_severity).unwrap_or(TelemetrySeverity::Unspecified) {
        TelemetrySeverity::Trace => (OTEL_SEVERITY_TRACE, "TRACE"),
        TelemetrySeverity::Debug => (OTEL_SEVERITY_DEBUG, "DEBUG"),
        TelemetrySeverity::Info => (OTEL_SEVERITY_INFO, "INFO"),
        TelemetrySeverity::Warn => (OTEL_SEVERITY_WARN, "WARN"),
        TelemetrySeverity::Error => (OTEL_SEVERITY_ERROR, "ERROR"),
        TelemetrySeverity::Fatal => (OTEL_SEVERITY_FATAL, "FATAL"),
        TelemetrySeverity::Unspecified => {
            match TelemetryKind::try_from(raw_kind).unwrap_or(TelemetryKind::Unspecified) {
                TelemetryKind::UncaughtError | TelemetryKind::UnhandledRejection => {
                    (OTEL_SEVERITY_ERROR, "ERROR")
                }
                TelemetryKind::WalletRpc
                | TelemetryKind::AuthHttp
                | TelemetryKind::Ws
                | TelemetryKind::Webrtc => (OTEL_SEVERITY_WARN, "WARN"),
                TelemetryKind::Unspecified => (OTEL_SEVERITY_INFO, "INFO"),
            }
        }
    }
}

pub fn decode_event_name(severity_number: u8) -> &'static str {
    if severity_number >= OTEL_SEVERITY_WARN {
        OTEL_EVENT_BROWSER_ERROR
    } else {
        OTEL_EVENT_BROWSER_LOG
    }
}

pub fn decode_kind(raw: i32) -> &'static str {
    match TelemetryKind::try_from(raw).unwrap_or(TelemetryKind::Unspecified) {
        TelemetryKind::Unspecified => "unspecified",
        TelemetryKind::UncaughtError => "uncaught_error",
        TelemetryKind::UnhandledRejection => "unhandled_rejection",
        TelemetryKind::WalletRpc => "wallet_rpc",
        TelemetryKind::AuthHttp => "auth_http",
        TelemetryKind::Ws => "ws",
        TelemetryKind::Webrtc => "webrtc",
    }
}

pub fn decode_op(raw: i32) -> &'static str {
    match TelemetryOp::try_from(raw).unwrap_or(TelemetryOp::Unspecified) {
        TelemetryOp::Unspecified => "unspecified",
        TelemetryOp::EthChainId => "eth_chainId",
        TelemetryOp::WalletSwitchEthereumChain => "wallet_switchEthereumChain",
        TelemetryOp::EthRequestAccounts => "eth_requestAccounts",
        TelemetryOp::PersonalSign => "personal_sign",
        TelemetryOp::EthSendTransaction => "eth_sendTransaction",
        TelemetryOp::AuthSession => "auth_session",
        TelemetryOp::AuthNonce => "auth_nonce",
        TelemetryOp::AuthVerify => "auth_verify",
        TelemetryOp::AuthClaimPayment => "auth_claim_payment",
        TelemetryOp::AuthNickname => "auth_nickname",
        TelemetryOp::AuthLogout => "auth_logout",
        TelemetryOp::ChatInit => "chat_init",
        TelemetryOp::WsConnect => "ws_connect",
        TelemetryOp::WsDecode => "ws_decode",
        TelemetryOp::WsServerError => "ws_server_error",
        TelemetryOp::VoiceGum => "voice_gum",
        TelemetryOp::VoiceOffer => "voice_offer",
        TelemetryOp::VoiceAnswer => "voice_answer",
        TelemetryOp::VoiceIce => "voice_ice",
        TelemetryOp::VoiceSignaling => "voice_signaling",
    }
}

pub fn decode_providers(flags: u32) -> String {
    const KNOWN: &[(u32, &str)] = &[
        (TelemetryProviderFlag::Ethereum as u32, "ethereum"),
        (TelemetryProviderFlag::Metamask as u32, "metamask"),
        (TelemetryProviderFlag::Phantom as u32, "phantom"),
        (TelemetryProviderFlag::Coinbase as u32, "coinbase"),
        (TelemetryProviderFlag::Rabby as u32, "rabby"),
        (TelemetryProviderFlag::Brave as u32, "brave"),
    ];
    let mut names = Vec::new();
    for &(mask, label) in KNOWN {
        if (flags & mask) != 0 {
            names.push(label);
        }
    }
    if names.is_empty() {
        "none".to_string()
    } else {
        names.join(",")
    }
}
