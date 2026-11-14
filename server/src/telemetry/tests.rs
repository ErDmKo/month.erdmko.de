use actix_web::{App, HttpServer, web};
use awc::ws::{CloseCode, Frame, Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::generated::telemetry::{
    TelemetryAck, TelemetryBatch, TelemetryEvent, TelemetryKind, TelemetryOp,
    TelemetryProviderFlag, TelemetrySeverity,
};

use super::sanitize::{
    MAX_CODE_CHARS, MAX_MESSAGE_CHARS, MAX_PATH_CHARS, build_record, sanitize_code,
    sanitize_message, sanitize_path,
};
use super::sink::{
    OTEL_EVENT_BROWSER_ERROR, OTEL_EVENT_BROWSER_LOG, OTEL_SEVERITY_DEBUG, OTEL_SEVERITY_ERROR,
    OTEL_SEVERITY_FATAL, OTEL_SEVERITY_INFO, OTEL_SEVERITY_TRACE, OTEL_SEVERITY_WARN,
    StdoutTelemetrySink, TelemetryRecord, TelemetrySink, decode_kind, decode_op, decode_providers,
    decode_severity,
};
use super::{
    MAX_TELEMETRY_BATCH_EVENTS, MAX_TELEMETRY_PAYLOAD_BYTES, TelemetryState, telemetry_ws_handler,
};

#[derive(Default)]
struct RecordingSink {
    records: Mutex<Vec<TelemetryRecord>>,
}

impl RecordingSink {
    fn snapshot(&self) -> Vec<TelemetryRecord> {
        self.records.lock().expect("sink mutex").clone()
    }
}

impl TelemetrySink for RecordingSink {
    fn emit(&self, record: &TelemetryRecord) {
        self.records
            .lock()
            .expect("sink mutex")
            .push(record.clone());
    }
}

fn spawn_telemetry_server(
    state: web::Data<TelemetryState>,
) -> (SocketAddr, actix_web::dev::ServerHandle) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    // Notice: no AppCtx, no SQLite pool, and no session middleware —
    // proving `/ws/telemetry` is 100% auth-, room-, and DB-independent.
    let server = HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .service(telemetry_ws_handler)
    })
    .shutdown_timeout(0)
    .listen(listener)
    .expect("listen")
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);
    (addr, handle)
}

fn sample_event(code: &str, message: &str) -> TelemetryEvent {
    TelemetryEvent {
        timestamp_ms: 1_794_614_400_123,
        severity: TelemetrySeverity::Error as i32,
        kind: TelemetryKind::WalletRpc as i32,
        op: TelemetryOp::PersonalSign as i32,
        code: code.to_string(),
        message: message.to_string(),
        path: "/chat?room=secret#hash".to_string(),
        line: 12,
        column: 34,
        chain_id: 1,
        provider_flags: (TelemetryProviderFlag::Ethereum as u32)
            | (TelemetryProviderFlag::Phantom as u32),
    }
}

#[test]
fn decodes_all_enums_severities_and_provider_bitmasks_on_server() {
    assert_eq!(
        decode_severity(TelemetrySeverity::Trace as i32, 0),
        (OTEL_SEVERITY_TRACE, "TRACE")
    );
    assert_eq!(
        decode_severity(TelemetrySeverity::Debug as i32, 0),
        (OTEL_SEVERITY_DEBUG, "DEBUG")
    );
    assert_eq!(
        decode_severity(TelemetrySeverity::Info as i32, 0),
        (OTEL_SEVERITY_INFO, "INFO")
    );
    assert_eq!(
        decode_severity(TelemetrySeverity::Warn as i32, 0),
        (OTEL_SEVERITY_WARN, "WARN")
    );
    assert_eq!(
        decode_severity(TelemetrySeverity::Error as i32, 0),
        (OTEL_SEVERITY_ERROR, "ERROR")
    );
    assert_eq!(
        decode_severity(TelemetrySeverity::Fatal as i32, 0),
        (OTEL_SEVERITY_FATAL, "FATAL")
    );
    assert_eq!(
        decode_severity(0, TelemetryKind::UncaughtError as i32),
        (OTEL_SEVERITY_ERROR, "ERROR")
    );
    assert_eq!(
        decode_severity(0, TelemetryKind::WalletRpc as i32),
        (OTEL_SEVERITY_WARN, "WARN")
    );
    assert_eq!(decode_severity(0, 0), (OTEL_SEVERITY_INFO, "INFO"));

    assert_eq!(
        decode_kind(TelemetryKind::Unspecified as i32),
        "unspecified"
    );
    assert_eq!(
        decode_kind(TelemetryKind::UncaughtError as i32),
        "uncaught_error"
    );
    assert_eq!(
        decode_kind(TelemetryKind::UnhandledRejection as i32),
        "unhandled_rejection"
    );
    assert_eq!(decode_kind(TelemetryKind::WalletRpc as i32), "wallet_rpc");
    assert_eq!(decode_kind(TelemetryKind::AuthHttp as i32), "auth_http");
    assert_eq!(decode_kind(TelemetryKind::Ws as i32), "ws");
    assert_eq!(decode_kind(TelemetryKind::Webrtc as i32), "webrtc");
    assert_eq!(decode_kind(999), "unspecified");

    assert_eq!(decode_op(TelemetryOp::PersonalSign as i32), "personal_sign");
    assert_eq!(
        decode_op(TelemetryOp::WalletSwitchEthereumChain as i32),
        "wallet_switchEthereumChain"
    );
    assert_eq!(
        decode_op(TelemetryOp::EthSendTransaction as i32),
        "eth_sendTransaction"
    );
    assert_eq!(
        decode_op(TelemetryOp::VoiceSignaling as i32),
        "voice_signaling"
    );
    assert_eq!(decode_op(-1), "unspecified");

    assert_eq!(decode_providers(0), "none");
    assert_eq!(decode_providers(1 << 20), "none");
    assert_eq!(
        decode_providers(
            (TelemetryProviderFlag::Ethereum as u32)
                | (TelemetryProviderFlag::Metamask as u32)
                | (TelemetryProviderFlag::Phantom as u32)
                | (TelemetryProviderFlag::Coinbase as u32)
                | (TelemetryProviderFlag::Rabby as u32)
                | (TelemetryProviderFlag::Brave as u32)
        ),
        "ethereum,metamask,phantom,coinbase,rabby,brave"
    );
}

#[test]
fn sanitizes_control_chars_queries_secrets_and_utf8_lengths() {
    assert_eq!(sanitize_code("  -32000\r\n\x00\x1b  "), "-32000");
    assert_eq!(
        sanitize_path("/chat/general?room=private&token=secret#frag\r\n"),
        "/chat/general"
    );

    let sig_hex = format!("0x{}", "ab".repeat(65));
    let raw_session = "cd".repeat(32);
    let wallet = "0xeff121f128e0e64c0e64ae8eb6eb042a0e5aa81c";
    let dirty = format!(
        "line1\r\nevent=forged\t\x00Cookie: month_session=secret_tok_123; sig={sig_hex} tok={raw_session} wallet={wallet}"
    );
    let cleaned = sanitize_message(&dirty);
    assert!(!cleaned.chars().any(char::is_control));
    assert!(cleaned.contains("line1 event=forged Cookie: month_session=[REDACTED];"));
    assert!(cleaned.contains("sig=[REDACTED_HEX]"));
    assert!(cleaned.contains("tok=[REDACTED_HEX]"));
    assert!(
        cleaned.contains(wallet),
        "40-hex-char wallet address should stay visible for debugging: {cleaned}"
    );
    assert!(!cleaned.contains("secret_tok_123"));

    // Multi-byte UTF-8 boundary safety
    let long_cyrillic = "Ж".repeat(400);
    assert_eq!(
        sanitize_code(&long_cyrillic).chars().count(),
        MAX_CODE_CHARS
    );
    assert_eq!(
        sanitize_path(&long_cyrillic).chars().count(),
        MAX_PATH_CHARS
    );
    assert_eq!(
        sanitize_message(&long_cyrillic).chars().count(),
        MAX_MESSAGE_CHARS
    );

    // Future client timestamp skew is clamped
    let mut ev = sample_event("-32000", "ok");
    ev.timestamp_ms = u64::MAX;
    let rec = build_record(&ev, 1_794_614_400_000);
    assert_eq!(rec.severity_number, OTEL_SEVERITY_ERROR);
    assert_eq!(rec.severity_text, "ERROR");
    assert_eq!(rec.event_name, OTEL_EVENT_BROWSER_ERROR);
    assert_eq!(rec.client_timestamp_ms, 1_794_614_400_000 + 86_400_000);

    // StdoutTelemetrySink formats dynamic severity_text (not hardcoded WARN)
    let mut stdout_buf = Vec::new();
    StdoutTelemetrySink::write_record(&mut stdout_buf, &rec).expect("write stdout line");
    let line = String::from_utf8(stdout_buf).expect("utf-8 stdout line");
    assert!(line.ends_with('\n'));
    assert_eq!(line.lines().count(), 1);
    assert!(line.contains("ERROR telemetry] event=browser.error severity=17 kind=wallet_rpc op=personal_sign code=\"-32000\" chain_id=1 providers=ethereum,phantom path=\"/chat\" loc=12:34"));

    // Lower severities (INFO / DEBUG) map to event=browser.log and 5-char padded level
    let mut info_ev = sample_event("", "connected");
    info_ev.severity = TelemetrySeverity::Info as i32;
    let info_rec = build_record(&info_ev, 1_794_614_400_000);
    assert_eq!(info_rec.severity_number, OTEL_SEVERITY_INFO);
    assert_eq!(info_rec.severity_text, "INFO");
    assert_eq!(info_rec.event_name, OTEL_EVENT_BROWSER_LOG);
    let mut info_buf = Vec::new();
    StdoutTelemetrySink::write_record(&mut info_buf, &info_rec).expect("write info stdout line");
    let info_line = String::from_utf8(info_buf).expect("utf-8 info line");
    assert!(info_line.contains("INFO  telemetry] event=browser.log severity=9"));
}

#[actix_web::test]
async fn unauthenticated_ws_ingests_batch_emits_otel_records_and_returns_ack() {
    let sink = Arc::new(RecordingSink::default());
    let state = web::Data::new(TelemetryState::with_sink(sink.clone()));
    let (addr, handle) = spawn_telemetry_server(state);

    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{addr}/ws/telemetry"))
        .set_header("Origin", "https://erdmko.dev")
        .connect()
        .await
        .expect("connect /ws/telemetry without session cookie");

    let batch = TelemetryBatch {
        ack_id: 42,
        events: vec![
            sample_event("-32000", "The app's signature request cannot be shown"),
            TelemetryEvent {
                timestamp_ms: 1_794_614_401_000,
                severity: TelemetrySeverity::Warn as i32,
                kind: TelemetryKind::Webrtc as i32,
                op: TelemetryOp::VoiceGum as i32,
                code: "NotAllowedError".to_string(),
                message: "Permission denied\nmonth_session=leak123".to_string(),
                path: "/chat/general".to_string(),
                line: 0,
                column: 0,
                chain_id: 0,
                provider_flags: 0,
            },
        ],
    };

    ws.send(WsMessage::Binary(batch.encode_to_vec().into()))
        .await
        .expect("send batch");

    let frame = actix_web::rt::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("ack timeout")
        .expect("stream open")
        .expect("valid ws frame");

    let Frame::Binary(ack_bytes) = frame else {
        panic!("expected binary TelemetryAck, got {frame:?}");
    };
    let ack = TelemetryAck::decode(ack_bytes.as_ref()).expect("decode TelemetryAck");
    assert_eq!(ack.ack_id, 42);

    let records = sink.snapshot();
    assert_eq!(records.len(), 2);

    assert_eq!(records[0].event_name, "browser.error");
    assert_eq!(records[0].severity_number, 17);
    assert_eq!(records[0].severity_text, "ERROR");
    assert_eq!(records[0].kind, "wallet_rpc");
    assert_eq!(records[0].op, "personal_sign");
    assert_eq!(records[0].code, "-32000");
    assert_eq!(records[0].path, "/chat");
    assert_eq!(records[0].chain_id, 1);
    assert_eq!(records[0].providers, "ethereum,phantom");

    assert_eq!(records[1].severity_number, 13);
    assert_eq!(records[1].severity_text, "WARN");
    assert_eq!(records[1].kind, "webrtc");
    assert_eq!(records[1].op, "voice_gum");
    assert_eq!(records[1].code, "NotAllowedError");
    assert_eq!(records[1].providers, "none");
    assert_eq!(
        records[1].message,
        "Permission denied month_session=[REDACTED]"
    );

    let _ = ws.close().await;
    handle.stop(true).await;
}

#[actix_web::test]
async fn rejects_missing_or_disallowed_origin_and_enforces_isolated_connection_cap() {
    let sink = Arc::new(RecordingSink::default());
    let mut raw_state = TelemetryState::with_sink(sink);
    raw_state.max_connections = 2;
    let state = web::Data::new(raw_state);
    let (addr, handle) = spawn_telemetry_server(state.clone());

    // Missing Origin -> 403
    match awc::Client::new()
        .ws(format!("ws://{addr}/ws/telemetry"))
        .connect()
        .await
    {
        Err(awc::error::WsClientError::InvalidResponseStatus(status)) => {
            assert_eq!(status, actix_web::http::StatusCode::FORBIDDEN);
        }
        Err(err) => panic!("expected 403 for missing Origin, got {err:?}"),
        Ok(_) => panic!("expected missing Origin to fail"),
    }

    // Disallowed Origin -> 403
    match awc::Client::new()
        .ws(format!("ws://{addr}/ws/telemetry"))
        .set_header("Origin", "https://evil.example")
        .connect()
        .await
    {
        Err(awc::error::WsClientError::InvalidResponseStatus(status)) => {
            assert_eq!(status, actix_web::http::StatusCode::FORBIDDEN);
        }
        Err(err) => panic!("expected 403 for disallowed Origin, got {err:?}"),
        Ok(_) => panic!("expected disallowed Origin to fail"),
    }

    // Open 2 connections (fills max_connections = 2)
    let (_r1, mut ws1) = awc::Client::new()
        .ws(format!("ws://{addr}/ws/telemetry"))
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("slot 1");
    let (_r2, mut ws2) = awc::Client::new()
        .ws(format!("ws://{addr}/ws/telemetry"))
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("slot 2");
    assert_eq!(state.open_connection_count(), 2);

    // 3rd connection rejected with 503 Service Unavailable
    match awc::Client::new()
        .ws(format!("ws://{addr}/ws/telemetry"))
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
    {
        Err(awc::error::WsClientError::InvalidResponseStatus(status)) => {
            assert_eq!(status, actix_web::http::StatusCode::SERVICE_UNAVAILABLE);
        }
        Err(err) => panic!("expected 503 when telemetry cap reached, got {err:?}"),
        Ok(_) => panic!("expected 3rd telemetry connection to fail"),
    }

    // Closing ws1 frees its slot so a new client can connect
    ws1.send(WsMessage::Close(None)).await.unwrap();
    for _ in 0..20 {
        if state.open_connection_count() == 1 {
            break;
        }
        actix_web::rt::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(state.open_connection_count(), 1);

    let (_r3, mut ws3) = awc::Client::new()
        .ws(format!("ws://{addr}/ws/telemetry"))
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("slot re-acquired after disconnect");
    let _ = ws2.close().await;
    let _ = ws3.close().await;

    handle.stop(true).await;
}

#[actix_web::test]
async fn rejects_malformed_oversized_excess_events_rate_burst_and_closes_idle_sockets() {
    let sink = Arc::new(RecordingSink::default());
    let mut raw_state = TelemetryState::with_sink(sink.clone());
    raw_state.rate_limit_max_batches = 2;
    raw_state.rate_limit_window = Duration::from_secs(60);
    raw_state.idle_timeout = Duration::from_millis(120);
    raw_state.heartbeat_interval = Duration::from_millis(25);
    let state = web::Data::new(raw_state);
    let (addr, handle) = spawn_telemetry_server(state.clone());

    // 1. Malformed protobuf closes socket with Policy without emitting
    {
        let (_r, mut ws) = awc::Client::new()
            .ws(format!("ws://{addr}/ws/telemetry"))
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .unwrap();
        ws.send(WsMessage::Binary(vec![0xff, 0xff, 0xff].into()))
            .await
            .unwrap();
        let frame = actix_web::rt::time::timeout(Duration::from_secs(1), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            Frame::Close(Some(reason)) => assert_eq!(reason.code, CloseCode::Policy),
            other => panic!("expected Policy close for malformed frame, got {other:?}"),
        }
    }

    // 2. Oversized frame (> 16 KiB) closes socket with Size
    {
        let (_r, mut ws) = awc::Client::new()
            .ws(format!("ws://{addr}/ws/telemetry"))
            .max_frame_size(MAX_TELEMETRY_PAYLOAD_BYTES * 2)
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .unwrap();
        ws.send(WsMessage::Binary(
            vec![0u8; MAX_TELEMETRY_PAYLOAD_BYTES + 1].into(),
        ))
        .await
        .unwrap();
        let frame = actix_web::rt::time::timeout(Duration::from_secs(1), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            Frame::Close(Some(reason)) => assert_eq!(reason.code, CloseCode::Size),
            other => panic!("expected Size close for oversized frame, got {other:?}"),
        }
    }

    // 3. Batch exceeding MAX_TELEMETRY_BATCH_EVENTS (16) closes socket with Policy
    {
        let (_r, mut ws) = awc::Client::new()
            .ws(format!("ws://{addr}/ws/telemetry"))
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .unwrap();
        let too_many = TelemetryBatch {
            ack_id: 1,
            events: (0..=MAX_TELEMETRY_BATCH_EVENTS)
                .map(|_| sample_event("ERR", "msg"))
                .collect(),
        };
        ws.send(WsMessage::Binary(too_many.encode_to_vec().into()))
            .await
            .unwrap();
        let frame = actix_web::rt::time::timeout(Duration::from_secs(1), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            Frame::Close(Some(reason)) => assert_eq!(reason.code, CloseCode::Policy),
            other => panic!("expected Policy close for excess events, got {other:?}"),
        }
    }

    assert!(sink.snapshot().is_empty());

    // 4. Per-connection rate limit allows 2 batches then closes on 3rd
    {
        let (_r, mut ws) = awc::Client::new()
            .ws(format!("ws://{addr}/ws/telemetry"))
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .unwrap();
        for ack_id in [1u32, 2u32] {
            let b = TelemetryBatch {
                ack_id,
                events: vec![sample_event("4001", "User rejected")],
            };
            ws.send(WsMessage::Binary(b.encode_to_vec().into()))
                .await
                .unwrap();
            let Some(Ok(Frame::Binary(bytes))) = ws.next().await else {
                panic!("expected ACK {ack_id}");
            };
            assert_eq!(TelemetryAck::decode(bytes.as_ref()).unwrap().ack_id, ack_id);
        }

        let burst = TelemetryBatch {
            ack_id: 3,
            events: vec![sample_event("4001", "User rejected")],
        };
        ws.send(WsMessage::Binary(burst.encode_to_vec().into()))
            .await
            .unwrap();
        let frame = actix_web::rt::time::timeout(Duration::from_secs(1), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            Frame::Close(Some(reason)) => assert_eq!(reason.code, CloseCode::Policy),
            other => panic!("expected Policy close on rate limit, got {other:?}"),
        }
        assert_eq!(sink.snapshot().len(), 2);
    }

    // 5. Idle connection automatically closes after idle_timeout and releases slot
    {
        let (_r, mut ws) = awc::Client::new()
            .ws(format!("ws://{addr}/ws/telemetry"))
            .set_header("Origin", "http://localhost:8080")
            .connect()
            .await
            .unwrap();
        let frame = actix_web::rt::time::timeout(Duration::from_secs(1), ws.next())
            .await
            .expect("idle close should fire within 1s")
            .unwrap()
            .unwrap();
        match frame {
            Frame::Close(Some(reason)) => assert_eq!(reason.code, CloseCode::Normal),
            other => panic!("expected Normal close on idle timeout, got {other:?}"),
        }
    }

    for _ in 0..20 {
        if state.open_connection_count() == 0 {
            break;
        }
        actix_web::rt::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(state.open_connection_count(), 0);

    handle.stop(true).await;
}
