pub mod http;
pub mod sanitize;
pub mod sink;

pub use http::{
    MAX_TELEMETRY_BATCH_EVENTS, MAX_TELEMETRY_PAYLOAD_BYTES, TelemetryState, post_telemetry_handler,
};
pub use sink::{StdoutTelemetrySink, TelemetryRecord, TelemetrySink};

#[cfg(test)]
mod tests;
