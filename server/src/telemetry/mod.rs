pub mod sanitize;
pub mod sink;
pub mod ws_actor;

pub use sink::{StdoutTelemetrySink, TelemetryRecord, TelemetrySink};
pub use ws_actor::{
    MAX_TELEMETRY_BATCH_EVENTS, MAX_TELEMETRY_CONNECTIONS, MAX_TELEMETRY_PAYLOAD_BYTES,
    TelemetryState, telemetry_ws_handler,
};

#[cfg(test)]
mod tests;
