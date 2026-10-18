use actix_web::HttpResponse;
use serde_json::{Value, json};

const SHORT_COMMIT_LEN: usize = 7;
const UNKNOWN: &str = "unknown";

/// Keep unresolved Bazel status placeholders (`{STABLE_...}`) and empty
/// values out of the public metadata.
fn env_or_unknown(value: Option<&'static str>) -> &'static str {
    match value {
        Some(value) if !value.is_empty() && !value.starts_with('{') => value,
        _ => UNKNOWN,
    }
}

/// Abbreviate a git revision for display, leaving shorter/placeholder values
/// (such as `unknown`) untouched.
pub fn short_commit(commit: &str) -> &str {
    commit.get(..SHORT_COMMIT_LEN).unwrap_or(commit)
}

pub fn branch() -> &'static str {
    env_or_unknown(option_env!("GIT_BRANCH"))
}

pub fn commit() -> &'static str {
    env_or_unknown(option_env!("GIT_COMMIT"))
}

pub fn dirty() -> bool {
    matches!(env_or_unknown(option_env!("GIT_DIRTY")), "1" | "true")
}

pub fn build_time() -> &'static str {
    env_or_unknown(option_env!("BUILD_TIME"))
}

/// Build metadata baked into the binary when the image is built.
pub fn info() -> Value {
    json!({
        "branch": branch(),
        "commit": commit(),
        "short_commit": short_commit(commit()),
        "dirty": dirty(),
        "build_time": build_time(),
    })
}

pub async fn version_handler() -> HttpResponse {
    HttpResponse::Ok().json(info())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_commit_truncates_full_hash() {
        assert_eq!(short_commit("0123456789abcdef"), "0123456");
    }

    #[test]
    fn short_commit_keeps_short_or_placeholder_values() {
        assert_eq!(short_commit("abc123"), "abc123");
        assert_eq!(short_commit("unknown"), "unknown");
    }

    #[test]
    fn unresolved_status_placeholders_fall_back_to_unknown() {
        assert_eq!(env_or_unknown(Some("{STABLE_GIT_COMMIT}")), UNKNOWN);
        assert_eq!(env_or_unknown(Some("")), UNKNOWN);
        assert_eq!(env_or_unknown(None), UNKNOWN);
    }

    #[test]
    fn info_contains_all_version_fields() {
        let value = info();
        for key in ["branch", "commit", "short_commit", "dirty", "build_time"] {
            assert!(value.get(key).is_some(), "missing version field {key}");
        }
    }

    #[actix_web::test]
    async fn version_endpoint_returns_build_metadata() {
        let app = actix_web::test::init_service(
            actix_web::App::new().route("/version", actix_web::web::get().to(version_handler)),
        )
        .await;
        let request = actix_web::test::TestRequest::get()
            .uri("/version")
            .to_request();
        let response = actix_web::test::call_service(&app, request).await;
        assert!(response.status().is_success());
        let body: Value = actix_web::test::read_body_json(response).await;
        for key in ["branch", "commit", "short_commit", "dirty", "build_time"] {
            assert!(body.get(key).is_some(), "missing version field {key}");
        }
    }
}
