use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, post, web};
use chrono::Utc;
use futures_util::StreamExt;
use log::warn;
use prost::Message;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::chat::service as chat_service;
use crate::generated::telemetry::TelemetryBatch;

use super::sanitize;
use super::sink::{StdoutTelemetrySink, TelemetryRecord, TelemetrySink};

pub const MAX_TELEMETRY_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_TELEMETRY_BATCH_EVENTS: usize = 16;
pub const DEFAULT_RATE_LIMIT_MAX_BATCHES: usize = 10;
pub const DEFAULT_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(10);
pub const DEFAULT_DEDUP_WINDOW: Duration = Duration::from_secs(5);
const MAX_TRACKED_RATE_KEYS: usize = 256;
const MAX_DEDUP_ENTRIES: usize = 512;

#[derive(Clone, PartialEq, Eq, Hash)]
struct DedupKey {
    client: String,
    kind: &'static str,
    op: &'static str,
    code: String,
    message: String,
}

static DEFAULT_TELEMETRY_STATE: LazyLock<web::Data<TelemetryState>> =
    LazyLock::new(|| web::Data::new(TelemetryState::default()));

pub struct TelemetryState {
    pub sink: Arc<dyn TelemetrySink>,
    pub rate_limit_max_batches: usize,
    pub rate_limit_window: Duration,
    pub dedup_window: Duration,
    rate_windows: Mutex<HashMap<String, VecDeque<Instant>>>,
    dedup_seen: Mutex<HashMap<DedupKey, Instant>>,
}

impl Default for TelemetryState {
    fn default() -> Self {
        Self::with_sink(Arc::new(StdoutTelemetrySink))
    }
}

impl TelemetryState {
    pub fn with_sink(sink: Arc<dyn TelemetrySink>) -> Self {
        Self {
            sink,
            rate_limit_max_batches: DEFAULT_RATE_LIMIT_MAX_BATCHES,
            rate_limit_window: DEFAULT_RATE_LIMIT_WINDOW,
            dedup_window: DEFAULT_DEDUP_WINDOW,
            rate_windows: Mutex::new(HashMap::new()),
            dedup_seen: Mutex::new(HashMap::new()),
        }
    }

    fn is_rate_limited(&self, client_key: &str, now: Instant) -> bool {
        let window = self.rate_limit_window;
        let max_batches = self.rate_limit_max_batches;
        let mut map = self
            .rate_windows
            .lock()
            .expect("telemetry rate limiter mutex");

        if map.len() >= MAX_TRACKED_RATE_KEYS && !map.contains_key(client_key) {
            map.retain(|_, q| {
                while let Some(&oldest) = q.front() {
                    if now.duration_since(oldest) > window {
                        q.pop_front();
                    } else {
                        break;
                    }
                }
                !q.is_empty()
            });
            if map.len() >= MAX_TRACKED_RATE_KEYS {
                if let Some(evict_key) = map.keys().next().cloned() {
                    map.remove(&evict_key);
                }
            }
        }

        let bucket = map.entry(client_key.to_string()).or_default();
        while let Some(&oldest) = bucket.front() {
            if now.duration_since(oldest) > window {
                bucket.pop_front();
            } else {
                break;
            }
        }
        if bucket.len() >= max_batches {
            return true;
        }
        bucket.push_back(now);
        false
    }

    fn should_emit(&self, client_key: &str, record: &TelemetryRecord, now: Instant) -> bool {
        let window = self.dedup_window;
        if window.is_zero() {
            return true;
        }
        let key = DedupKey {
            client: client_key.to_string(),
            kind: record.kind,
            op: record.op,
            code: record.code.clone(),
            message: record.message.clone(),
        };
        let mut seen = self.dedup_seen.lock().expect("telemetry dedup mutex");
        if let Some(&prev) = seen.get(&key) {
            if now.duration_since(prev) < window {
                return false;
            }
        }
        if seen.len() >= MAX_DEDUP_ENTRIES && !seen.contains_key(&key) {
            seen.retain(|_, ts| now.duration_since(*ts) < window);
            if seen.len() >= MAX_DEDUP_ENTRIES {
                if let Some(oldest_key) = seen
                    .iter()
                    .min_by_key(|(_, ts)| **ts)
                    .map(|(k, _)| k.clone())
                {
                    seen.remove(&oldest_key);
                }
            }
        }
        seen.insert(key, now);
        true
    }
}

fn extract_client_key(req: &HttpRequest) -> String {
    let conn_info = req.connection_info();
    let Some(raw) = conn_info.realip_remote_addr() else {
        return "unknown".to_string();
    };
    let trimmed = raw.trim();
    if let Ok(sock) = trimmed.parse::<std::net::SocketAddr>() {
        return sock.ip().to_string();
    }
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

#[post("/telemetry")]
pub async fn post_telemetry_handler(req: HttpRequest, mut payload: web::Payload) -> HttpResponse {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let Some(origin) = origin else {
        warn!(
            target: "telemetry",
            "event=telemetry_reject code=FORBIDDEN_ORIGIN reason=missing_origin"
        );
        return HttpResponse::Forbidden().body("Origin is required.");
    };
    if !chat_service::is_allowed_origin(origin) {
        warn!(
            target: "telemetry",
            "event=telemetry_reject code=FORBIDDEN_ORIGIN reason=origin_not_allowed origin={:?}",
            origin
        );
        return HttpResponse::Forbidden().body("Origin is not allowed.");
    }

    let state = req
        .app_data::<web::Data<TelemetryState>>()
        .cloned()
        .unwrap_or_else(|| DEFAULT_TELEMETRY_STATE.clone());

    let mut bytes = web::BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().body("Invalid telemetry payload stream.");
        };
        if bytes.len().saturating_add(chunk.len()) > MAX_TELEMETRY_PAYLOAD_BYTES {
            return HttpResponse::PayloadTooLarge().body("Telemetry batch exceeds size limit.");
        }
        bytes.extend_from_slice(&chunk);
    }

    if bytes.is_empty() {
        return HttpResponse::BadRequest().body("Empty telemetry batch.");
    }

    let now = Instant::now();
    let client_key = extract_client_key(&req);
    if state.is_rate_limited(&client_key, now) {
        return HttpResponse::TooManyRequests().body("Telemetry rate limit exceeded.");
    }

    let Ok(batch) = TelemetryBatch::decode(bytes.as_ref()) else {
        return HttpResponse::BadRequest().body("Malformed telemetry batch.");
    };

    if batch.events.is_empty() || batch.events.len() > MAX_TELEMETRY_BATCH_EVENTS {
        return HttpResponse::BadRequest().body("Invalid telemetry batch event count.");
    }

    let observed_ms = Utc::now().timestamp_millis();
    for event in &batch.events {
        let record = sanitize::build_record(event, observed_ms);
        if state.should_emit(&client_key, &record, now) {
            state.sink.emit(&record);
        }
    }

    HttpResponse::NoContent().finish()
}
