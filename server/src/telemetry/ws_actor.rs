use actix::{Actor, ActorContext, AsyncContext, StreamHandler};
use actix_web::http::header;
use actix_web::{Error, HttpRequest, HttpResponse, get, web};
use actix_web_actors::ws;
use chrono::Utc;
use log::warn;
use prost::Message;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use crate::chat::service as chat_service;
use crate::generated::telemetry::{TelemetryAck, TelemetryBatch};

use super::sanitize;
use super::sink::{StdoutTelemetrySink, TelemetrySink};

pub const MAX_TELEMETRY_CONNECTIONS: usize = 64;
pub const MAX_TELEMETRY_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_TELEMETRY_BATCH_EVENTS: usize = 16;
pub const DEFAULT_RATE_LIMIT_MAX_BATCHES: usize = 10;
pub const DEFAULT_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(10);
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

static DEFAULT_TELEMETRY_STATE: LazyLock<web::Data<TelemetryState>> =
    LazyLock::new(|| web::Data::new(TelemetryState::default()));

pub struct TelemetryState {
    pub sink: Arc<dyn TelemetrySink>,
    pub max_connections: usize,
    pub rate_limit_max_batches: usize,
    pub rate_limit_window: Duration,
    pub idle_timeout: Duration,
    pub heartbeat_interval: Duration,
    open_connections: Arc<AtomicUsize>,
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
            max_connections: MAX_TELEMETRY_CONNECTIONS,
            rate_limit_max_batches: DEFAULT_RATE_LIMIT_MAX_BATCHES,
            rate_limit_window: DEFAULT_RATE_LIMIT_WINDOW,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL,
            open_connections: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn open_connection_count(&self) -> usize {
        self.open_connections.load(Ordering::Acquire)
    }

    fn try_acquire_slot(&self) -> Option<ConnectionSlotGuard> {
        let max = self.max_connections;
        self.open_connections
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |cur| {
                if cur >= max { None } else { Some(cur + 1) }
            })
            .ok()?;
        Some(ConnectionSlotGuard {
            counter: Arc::clone(&self.open_connections),
        })
    }
}

struct ConnectionSlotGuard {
    counter: Arc<AtomicUsize>,
}

impl Drop for ConnectionSlotGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

struct TelemetryWs {
    state: web::Data<TelemetryState>,
    _slot: ConnectionSlotGuard,
    batch_timestamps: VecDeque<Instant>,
    last_activity: Instant,
}

impl TelemetryWs {
    fn new(state: web::Data<TelemetryState>, slot: ConnectionSlotGuard) -> Self {
        Self {
            state,
            _slot: slot,
            batch_timestamps: VecDeque::new(),
            last_activity: Instant::now(),
        }
    }

    fn is_rate_limited(&mut self, now: Instant) -> bool {
        let window = self.state.rate_limit_window;
        while let Some(&oldest) = self.batch_timestamps.front() {
            if now.duration_since(oldest) > window {
                self.batch_timestamps.pop_front();
            } else {
                break;
            }
        }
        if self.batch_timestamps.len() >= self.state.rate_limit_max_batches {
            return true;
        }
        self.batch_timestamps.push_back(now);
        false
    }

    fn close_with(ctx: &mut ws::WebsocketContext<Self>, code: ws::CloseCode, reason: &'static str) {
        ctx.close(Some(ws::CloseReason {
            code,
            description: Some(reason.to_string()),
        }));
        ctx.stop();
    }

    fn on_binary(&mut self, bytes: &[u8], ctx: &mut ws::WebsocketContext<Self>) {
        if bytes.is_empty() || bytes.len() > MAX_TELEMETRY_PAYLOAD_BYTES {
            Self::close_with(ctx, ws::CloseCode::Size, "BAD_PAYLOAD_SIZE");
            return;
        }

        let now = Instant::now();
        self.last_activity = now;
        if self.is_rate_limited(now) {
            Self::close_with(ctx, ws::CloseCode::Policy, "RATE_LIMITED");
            return;
        }

        let Ok(batch) = TelemetryBatch::decode(bytes) else {
            Self::close_with(ctx, ws::CloseCode::Policy, "MALFORMED_BATCH");
            return;
        };

        if batch.events.is_empty() || batch.events.len() > MAX_TELEMETRY_BATCH_EVENTS {
            Self::close_with(ctx, ws::CloseCode::Policy, "INVALID_BATCH_EVENTS");
            return;
        }

        let observed_ms = Utc::now().timestamp_millis();
        for event in &batch.events {
            let record = sanitize::build_record(event, observed_ms);
            self.state.sink.emit(&record);
        }

        let ack = TelemetryAck {
            ack_id: batch.ack_id,
        };
        ctx.binary(ack.encode_to_vec());
    }
}

impl Actor for TelemetryWs {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        let idle_timeout = self.state.idle_timeout;
        let check_interval = self
            .state
            .heartbeat_interval
            .min(idle_timeout / 2)
            .max(Duration::from_millis(10));
        ctx.run_interval(check_interval, move |act, ctx| {
            if Instant::now().duration_since(act.last_activity) > idle_timeout {
                Self::close_with(ctx, ws::CloseCode::Normal, "IDLE_TIMEOUT");
            }
        });
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for TelemetryWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Binary(bytes)) => {
                self.on_binary(&bytes, ctx);
            }
            Ok(ws::Message::Ping(bytes)) => {
                self.last_activity = Instant::now();
                ctx.pong(&bytes);
            }
            Ok(ws::Message::Pong(_)) => {
                self.last_activity = Instant::now();
            }
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop();
            }
            Ok(ws::Message::Text(_)) | Ok(ws::Message::Continuation(_)) => {
                Self::close_with(ctx, ws::CloseCode::Unsupported, "BINARY_ONLY");
            }
            Ok(ws::Message::Nop) => {}
            Err(ws::ProtocolError::Overflow) => {
                Self::close_with(ctx, ws::CloseCode::Size, "FRAME_TOO_LARGE");
            }
            Err(_) => {
                Self::close_with(ctx, ws::CloseCode::Protocol, "PROTOCOL_ERROR");
            }
        }
    }
}

#[get("/ws/telemetry")]
pub async fn telemetry_ws_handler(
    req: HttpRequest,
    stream: web::Payload,
) -> Result<HttpResponse, Error> {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let Some(origin) = origin else {
        warn!(
            target: "telemetry",
            "event=telemetry_reject code=FORBIDDEN_ORIGIN reason=missing_origin"
        );
        return Err(actix_web::error::ErrorForbidden("Origin is required."));
    };
    if !chat_service::is_allowed_origin(origin) {
        warn!(
            target: "telemetry",
            "event=telemetry_reject code=FORBIDDEN_ORIGIN reason=origin_not_allowed origin={:?}",
            origin
        );
        return Err(actix_web::error::ErrorForbidden("Origin is not allowed."));
    }

    let state = req
        .app_data::<web::Data<TelemetryState>>()
        .cloned()
        .unwrap_or_else(|| DEFAULT_TELEMETRY_STATE.clone());

    let Some(slot) = state.try_acquire_slot() else {
        warn!(
            target: "telemetry",
            "event=telemetry_reject code=CONNECTION_LIMIT_EXCEEDED max={}",
            state.max_connections
        );
        return Err(actix_web::error::ErrorServiceUnavailable(
            "Too many telemetry connections.",
        ));
    };

    ws::WsResponseBuilder::new(TelemetryWs::new(state, slot), &req, stream)
        .frame_size(MAX_TELEMETRY_PAYLOAD_BYTES)
        .start()
}
