use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, get, post, web};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::app::AppCtx;
use crate::auth::db::{
    WalletProfile, create_session, get_valid_session_wallet, get_wallet_profile, issue_nonce,
    revoke_session,
};
use crate::auth::error::{AuthError, AuthErrorKind};
use crate::auth::siwe::verify_siwe_and_consume_nonce;
use crate::auth::{NONCE_TTL_SECS, SESSION_COOKIE_NAME, SESSION_TTL_SECS};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NonceRequest {
    pub wallet_address: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NonceResponse {
    pub nonce: String,
    pub wallet_address: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifySiweRequest {
    pub message: String,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusResponse {
    pub wallet_address: String,
    pub nickname: Option<String>,
    pub access_until: i64,
    pub has_active_access: bool,
}

impl From<WalletProfile> for SessionStatusResponse {
    fn from(profile: WalletProfile) -> Self {
        Self {
            wallet_address: profile.wallet_address,
            nickname: profile.nickname,
            access_until: profile.access_until,
            has_active_access: profile.has_active_access,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AuthErrorResponse {
    pub code: String,
    pub message: String,
}

pub(crate) fn auth_error_to_response(err: AuthError) -> HttpResponse {
    let body = AuthErrorResponse {
        code: err.code().to_string(),
        message: err.message().to_string(),
    };
    match err.kind() {
        AuthErrorKind::Validation => HttpResponse::BadRequest().json(body),
        AuthErrorKind::Unauthorized => HttpResponse::Unauthorized().json(body),
        AuthErrorKind::Conflict => HttpResponse::Conflict().json(body),
        AuthErrorKind::Internal => HttpResponse::InternalServerError().json(body),
    }
}

pub(crate) fn extract_session_token(req: &HttpRequest) -> Option<String> {
    let cookie_header = req.headers().get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some(val) = trimmed.strip_prefix(SESSION_COOKIE_NAME) {
            if let Some(token) = val.strip_prefix('=') {
                let token = token.trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn format_session_set_cookie(token: &str, max_age_secs: i64) -> String {
    format!(
        "{SESSION_COOKIE_NAME}={token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={max_age_secs}"
    )
}

#[post("/auth/nonce")]
pub async fn post_auth_nonce_handler(
    app_ctx: web::Data<AppCtx>,
    payload: web::Json<NonceRequest>,
) -> HttpResponse {
    let pool = app_ctx.pool.clone();
    let wallet_address = payload.into_inner().wallet_address;
    let now_unix = Utc::now().timestamp();

    let result = web::block(move || {
        let conn = pool.get().map_err(|err| {
            AuthError::internal("Database connection pool unavailable.", format!("{err:?}"))
        })?;
        issue_nonce(&conn, &wallet_address, now_unix, NONCE_TTL_SECS)
    })
    .await;

    match result {
        Ok(Ok(issued)) => HttpResponse::Ok().json(NonceResponse {
            nonce: issued.nonce,
            wallet_address: issued.wallet_address,
            expires_at: issued.expires_at,
        }),
        Ok(Err(err)) => auth_error_to_response(err),
        Err(err) => auth_error_to_response(AuthError::internal(
            "Failed to execute nonce request.",
            format!("{err:?}"),
        )),
    }
}

#[post("/auth/verify")]
pub async fn post_auth_verify_handler(
    app_ctx: web::Data<AppCtx>,
    payload: web::Json<VerifySiweRequest>,
) -> HttpResponse {
    let pool = app_ctx.pool.clone();
    let req_body = payload.into_inner();
    let now_unix = Utc::now().timestamp();

    let result = web::block(move || {
        let conn = pool.get().map_err(|err| {
            AuthError::internal("Database connection pool unavailable.", format!("{err:?}"))
        })?;
        let verified = verify_siwe_and_consume_nonce(
            &conn,
            &req_body.message,
            &req_body.signature,
            None,
            None,
            now_unix,
        )?;
        let session = create_session(&conn, &verified.address, now_unix, SESSION_TTL_SECS)?;
        let profile = get_wallet_profile(&conn, &verified.address, now_unix)?;
        Ok::<_, AuthError>((session, profile))
    })
    .await;

    match result {
        Ok(Ok((session, profile))) => HttpResponse::Ok()
            .insert_header((
                header::SET_COOKIE,
                format_session_set_cookie(&session.token, SESSION_TTL_SECS),
            ))
            .json(SessionStatusResponse::from(profile)),
        Ok(Err(err)) => auth_error_to_response(err),
        Err(err) => auth_error_to_response(AuthError::internal(
            "Failed to verify SIWE signature.",
            format!("{err:?}"),
        )),
    }
}

#[get("/auth/session")]
pub async fn get_auth_session_handler(
    req: HttpRequest,
    app_ctx: web::Data<AppCtx>,
) -> HttpResponse {
    let Some(token) = extract_session_token(&req) else {
        return auth_error_to_response(AuthError::unauthorized(
            "UNAUTHORIZED",
            "Missing session cookie.",
        ));
    };

    let pool = app_ctx.pool.clone();
    let now_unix = Utc::now().timestamp();

    let result = web::block(move || {
        let conn = pool.get().map_err(|err| {
            AuthError::internal("Database connection pool unavailable.", format!("{err:?}"))
        })?;
        let Some(wallet_address) = get_valid_session_wallet(&conn, &token, now_unix)? else {
            return Err(AuthError::unauthorized(
                "UNAUTHORIZED",
                "Session is invalid or expired.",
            ));
        };
        get_wallet_profile(&conn, &wallet_address, now_unix)
    })
    .await;

    match result {
        Ok(Ok(profile)) => HttpResponse::Ok().json(SessionStatusResponse::from(profile)),
        Ok(Err(err)) => auth_error_to_response(err),
        Err(err) => auth_error_to_response(AuthError::internal(
            "Failed to resolve auth session.",
            format!("{err:?}"),
        )),
    }
}

#[post("/auth/logout")]
pub async fn post_auth_logout_handler(
    req: HttpRequest,
    app_ctx: web::Data<AppCtx>,
) -> HttpResponse {
    if let Some(token) = extract_session_token(&req) {
        let pool = app_ctx.pool.clone();
        let _ = web::block(move || {
            if let Ok(conn) = pool.get() {
                let _ = revoke_session(&conn, &token);
            }
        })
        .await;
    }

    HttpResponse::Ok()
        .insert_header((header::SET_COOKIE, format_session_set_cookie("", 0)))
        .json(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::db::init_auth_schema;
    use crate::auth::siwe::test_helpers::{sign_personal_message, wallet_address_from_private_key};
    use crate::auth::siwe::{SiweMessage, format_siwe_message};
    use actix_web::{App, http::StatusCode, test};
    use chrono::Duration;
    use r2d2_sqlite::SqliteConnectionManager;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const PRIV_KEY_1: [u8; 32] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 1,
    ];

    fn setup_test_ctx() -> web::Data<AppCtx> {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("month_auth_http_test_{nanos}_{n}.sqlite"));

        let manager = SqliteConnectionManager::file(db_path);
        let pool = crate::app::Pool::new(manager).expect("pool created");
        let conn = pool.get().expect("conn available");
        init_auth_schema(&conn).expect("auth schema initialized");

        web::Data::new(AppCtx {
            static_path: PathBuf::new(),
            pool,
            css: serde_json::Value::Object(serde_json::Map::new()),
        })
    }

    #[actix_web::test]
    async fn nonce_verify_session_logout_and_replay_rejection() {
        let ctx = setup_test_ctx();
        let app = test::init_service(
            App::new()
                .app_data(ctx.clone())
                .service(post_auth_nonce_handler)
                .service(post_auth_verify_handler)
                .service(get_auth_session_handler)
                .service(post_auth_logout_handler),
        )
        .await;

        let wallet = wallet_address_from_private_key(&PRIV_KEY_1);

        // 1. POST /auth/nonce issues challenge
        let nonce_req = test::TestRequest::post()
            .uri("/auth/nonce")
            .set_json(NonceRequest {
                wallet_address: wallet.to_uppercase().replacen("0X", "0x", 1),
            })
            .to_request();
        let nonce_resp = test::call_service(&app, nonce_req).await;
        assert_eq!(nonce_resp.status(), StatusCode::OK);
        let issued: NonceResponse = test::read_body_json(nonce_resp).await;
        assert_eq!(issued.wallet_address, wallet);
        assert_eq!(issued.nonce.len(), 32);

        // 2. Build EIP-4361 message and sign with PRIV_KEY_1
        let now = Utc::now();
        let siwe_msg = format_siwe_message(&SiweMessage {
            domain: "erdmko.dev".to_string(),
            address: wallet.clone(),
            statement: Some("Sign in to month.erdmko.de".to_string()),
            uri: "https://erdmko.dev/chat/general".to_string(),
            version: "1".to_string(),
            chain_id: 1,
            nonce: issued.nonce.clone(),
            issued_at: now.to_rfc3339(),
            expiration_time: Some((now + Duration::minutes(5)).to_rfc3339()),
            not_before: None,
            request_id: None,
        });
        let signature = sign_personal_message(&PRIV_KEY_1, &siwe_msg);

        // 3. POST /auth/verify sets HttpOnly cookie and returns session status
        let verify_req = test::TestRequest::post()
            .uri("/auth/verify")
            .set_json(VerifySiweRequest {
                message: siwe_msg.clone(),
                signature: signature.clone(),
            })
            .to_request();
        let verify_resp = test::call_service(&app, verify_req).await;
        assert_eq!(verify_resp.status(), StatusCode::OK);

        let set_cookie = verify_resp
            .headers()
            .get(header::SET_COOKIE)
            .expect("Set-Cookie header should be present")
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.contains("month_session="));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("Secure"));
        assert!(set_cookie.contains("SameSite=Lax"));

        let status_body: SessionStatusResponse = test::read_body_json(verify_resp).await;
        assert_eq!(status_body.wallet_address, wallet);
        assert!(!status_body.has_active_access);

        // Extract `month_session=<token>` pair for subsequent requests
        let cookie_pair = set_cookie
            .split(';')
            .next()
            .expect("cookie key=value should exist")
            .to_string();

        // 4. Replaying the same /auth/verify payload fails with 401 Unauthorized
        let replay_req = test::TestRequest::post()
            .uri("/auth/verify")
            .set_json(VerifySiweRequest {
                message: siwe_msg,
                signature,
            })
            .to_request();
        let replay_resp = test::call_service(&app, replay_req).await;
        assert_eq!(replay_resp.status(), StatusCode::UNAUTHORIZED);

        // 5. GET /auth/session with cookie returns wallet address
        let session_req = test::TestRequest::get()
            .uri("/auth/session")
            .insert_header((header::COOKIE, cookie_pair.clone()))
            .to_request();
        let session_resp = test::call_service(&app, session_req).await;
        assert_eq!(session_resp.status(), StatusCode::OK);
        let resolved: SessionStatusResponse = test::read_body_json(session_resp).await;
        assert_eq!(resolved.wallet_address, wallet);

        // 6. POST /auth/logout revokes the session in SQLite
        let logout_req = test::TestRequest::post()
            .uri("/auth/logout")
            .insert_header((header::COOKIE, cookie_pair.clone()))
            .to_request();
        let logout_resp = test::call_service(&app, logout_req).await;
        assert_eq!(logout_resp.status(), StatusCode::OK);

        // 7. Subsequent GET /auth/session with the revoked cookie returns 401
        let after_logout_req = test::TestRequest::get()
            .uri("/auth/session")
            .insert_header((header::COOKIE, cookie_pair))
            .to_request();
        let after_logout_resp = test::call_service(&app, after_logout_req).await;
        assert_eq!(after_logout_resp.status(), StatusCode::UNAUTHORIZED);
    }
}
