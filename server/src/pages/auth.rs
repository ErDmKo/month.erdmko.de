use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, get, post, web};
use chrono::Utc;
use prost::Message;
use std::sync::Arc;

use crate::app::AppCtx;
use crate::auth::db::{
    ClaimPaymentDbError, WalletProfile, claim_payment_atomically, create_session,
    get_valid_session_wallet, get_wallet_profile, issue_nonce, revoke_session, set_wallet_nickname,
};
use crate::auth::error::{AuthError, AuthErrorKind};
use crate::auth::payment::{
    PaymentConfig, PaymentVerificationError, PaymentVerifier, RpcPaymentVerifier,
};
use crate::auth::service::{normalize_tx_hash, validate_ascii_nickname};
use crate::auth::siwe::{
    DEFAULT_SIWE_DOMAIN, SIWE_VERSION, SiweMessage, format_siwe_message, is_allowed_siwe_domain,
    to_checksum_address, verify_siwe_and_consume_nonce,
};
use crate::auth::{NONCE_TTL_SECS, SESSION_COOKIE_NAME, SESSION_TTL_SECS};
use crate::generated::chat::{
    AuthSession, ClaimPaymentRequest, ClaimPaymentResponse, NonceRequest, NonceResponse,
    PaymentClaimNotice, SetNicknameRequest, VerifySiweRequest, claim_payment_response,
};

const PROTO_CONTENT_TYPE: &str = "application/x-protobuf";

pub(crate) fn resolve_payment_config(cfg: Option<web::Data<PaymentConfig>>) -> PaymentConfig {
    cfg.map(|c| c.get_ref().clone())
        .unwrap_or_else(PaymentConfig::from_env)
}

fn proto_ok<M: Message>(msg: M) -> HttpResponse {
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
        .body(msg.encode_to_vec())
}

fn auth_session_from_profile(profile: WalletProfile, config: &PaymentConfig) -> AuthSession {
    AuthSession {
        wallet_address: profile.wallet_address,
        nickname: profile.nickname.unwrap_or_default(),
        access_until: profile.access_until,
        has_active_access: profile.has_active_access,
        payment_config: Some(config.to_proto()),
    }
}

fn unauthenticated_session_proto(config: &PaymentConfig) -> HttpResponse {
    proto_ok(AuthSession {
        wallet_address: String::new(),
        nickname: String::new(),
        access_until: 0,
        has_active_access: false,
        payment_config: Some(config.to_proto()),
    })
}

pub(crate) fn auth_error_to_response(err: AuthError) -> HttpResponse {
    let bytes = PaymentClaimNotice {
        message: err.message().to_string(),
    }
    .encode_to_vec();
    let mut builder = match err.kind() {
        AuthErrorKind::Validation => HttpResponse::BadRequest(),
        AuthErrorKind::Unauthorized => HttpResponse::Unauthorized(),
        AuthErrorKind::Conflict => HttpResponse::Conflict(),
        AuthErrorKind::Internal => HttpResponse::InternalServerError(),
    };
    builder
        .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
        .body(bytes)
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

fn extract_url_authority(raw_url: &str) -> Option<&str> {
    let trimmed = raw_url.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    let authority = without_scheme.split('/').next()?.trim();
    if authority.is_empty() {
        None
    } else {
        Some(authority)
    }
}

fn resolve_siwe_domain_and_uri(req: &HttpRequest) -> (String, String) {
    if let Some(referer) = req
        .headers()
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = referer.trim();
        if let Some(authority) = extract_url_authority(trimmed) {
            if is_allowed_siwe_domain(authority) {
                return (authority.to_string(), trimmed.to_string());
            }
        }
    }

    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = origin.trim().trim_end_matches('/');
        if let Some(authority) = extract_url_authority(trimmed) {
            if is_allowed_siwe_domain(authority) {
                return (authority.to_string(), format!("{trimmed}/chat"));
            }
        }
    }

    if let Some(host) = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
    {
        let authority = host.trim();
        if is_allowed_siwe_domain(authority) {
            let is_local = authority.starts_with("localhost") || authority.starts_with("127.0.0.1");
            let scheme = req
                .headers()
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| *s == "http" || *s == "https")
                .unwrap_or(if is_local { "http" } else { "https" });
            return (
                authority.to_string(),
                format!("{scheme}://{authority}/chat"),
            );
        }
    }

    (
        DEFAULT_SIWE_DOMAIN.to_string(),
        format!("https://{DEFAULT_SIWE_DOMAIN}/chat"),
    )
}

#[post("/auth/nonce")]
pub async fn post_auth_nonce_handler(
    req: HttpRequest,
    app_ctx: web::Data<AppCtx>,
    payment_cfg: Option<web::Data<PaymentConfig>>,
    body: web::Bytes,
) -> HttpResponse {
    let req_body = match NonceRequest::decode(body.as_ref()) {
        Ok(decoded) => decoded,
        Err(_) => {
            return auth_error_to_response(AuthError::validation("Malformed nonce request."));
        }
    };
    let config = resolve_payment_config(payment_cfg);
    let (domain, uri) = resolve_siwe_domain_and_uri(&req);
    let pool = app_ctx.pool.clone();
    let wallet_address = req_body.wallet_address;
    let now_unix = Utc::now().timestamp();

    let result = web::block(move || {
        let conn = pool.get().map_err(|err| {
            AuthError::internal("Database connection pool unavailable.", format!("{err:?}"))
        })?;
        issue_nonce(&conn, &wallet_address, now_unix, NONCE_TTL_SECS)
    })
    .await;

    match result {
        Ok(Ok(issued)) => {
            let checksum_wallet =
                to_checksum_address(&issued.wallet_address).unwrap_or(issued.wallet_address);
            let issued_at = chrono::DateTime::from_timestamp(issued.created_at, 0)
                .unwrap_or_else(Utc::now)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let siwe_message = format_siwe_message(&SiweMessage {
                domain,
                address: checksum_wallet.clone(),
                statement: Some("Sign in to month.erdmko.de chat.".to_string()),
                uri,
                version: SIWE_VERSION.to_string(),
                chain_id: config.chain_id,
                nonce: issued.nonce.clone(),
                issued_at,
                expiration_time: None,
                not_before: None,
                request_id: None,
            });
            proto_ok(NonceResponse {
                nonce: issued.nonce,
                wallet_address: checksum_wallet,
                expires_at: issued.expires_at,
                payment_config: Some(config.to_proto()),
                siwe_message,
            })
        }
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
    payment_cfg: Option<web::Data<PaymentConfig>>,
    body: web::Bytes,
) -> HttpResponse {
    let req_body = match VerifySiweRequest::decode(body.as_ref()) {
        Ok(decoded) => decoded,
        Err(_) => {
            return auth_error_to_response(AuthError::validation(
                "Malformed SIWE verification request.",
            ));
        }
    };
    let config = resolve_payment_config(payment_cfg);
    let expected_chain_id = config.chain_id;
    let pool = app_ctx.pool.clone();
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
            Some(expected_chain_id),
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
            .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
            .body(auth_session_from_profile(profile, &config).encode_to_vec()),
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
    payment_cfg: Option<web::Data<PaymentConfig>>,
) -> HttpResponse {
    let config = resolve_payment_config(payment_cfg);
    let Some(token) = extract_session_token(&req) else {
        return unauthenticated_session_proto(&config);
    };

    let pool = app_ctx.pool.clone();
    let now_unix = Utc::now().timestamp();

    let result = web::block(move || {
        let conn = pool.get().map_err(|err| {
            AuthError::internal("Database connection pool unavailable.", format!("{err:?}"))
        })?;
        let Some(wallet_address) = get_valid_session_wallet(&conn, &token, now_unix)? else {
            return Ok(None);
        };
        get_wallet_profile(&conn, &wallet_address, now_unix).map(Some)
    })
    .await;

    match result {
        Ok(Ok(Some(profile))) => proto_ok(auth_session_from_profile(profile, &config)),
        Ok(Ok(None)) => unauthenticated_session_proto(&config),
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
        .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
        .finish()
}

fn claim_payment_proto_response(payload: claim_payment_response::Payload) -> HttpResponse {
    proto_ok(ClaimPaymentResponse {
        payload: Some(payload),
    })
}

#[post("/auth/claim-payment")]
pub async fn post_auth_claim_payment_handler(
    req: HttpRequest,
    app_ctx: web::Data<AppCtx>,
    payment_cfg: Option<web::Data<PaymentConfig>>,
    verifier: Option<web::Data<Arc<dyn PaymentVerifier>>>,
    body: web::Bytes,
) -> HttpResponse {
    let config = resolve_payment_config(payment_cfg);
    let Some(token) = extract_session_token(&req) else {
        return claim_payment_proto_response(claim_payment_response::Payload::Unauthorized(
            PaymentClaimNotice {
                message: "Missing session cookie.".to_string(),
            },
        ));
    };

    let req_body = match ClaimPaymentRequest::decode(body.as_ref()) {
        Ok(decoded) => decoded,
        Err(_) => {
            return claim_payment_proto_response(
                claim_payment_response::Payload::InvalidTransaction(PaymentClaimNotice {
                    message: "Malformed payment claim request.".to_string(),
                }),
            );
        }
    };

    let tx_hash = match normalize_tx_hash(&req_body.tx_hash) {
        Ok(h) => h,
        Err(err) => {
            return claim_payment_proto_response(
                claim_payment_response::Payload::InvalidTransaction(PaymentClaimNotice {
                    message: err.message().to_string(),
                }),
            );
        }
    };
    let normalized_nickname = match Some(req_body.nickname.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw_nick) => match validate_ascii_nickname(raw_nick) {
            Ok(n) => Some(n),
            Err(err) => {
                return claim_payment_proto_response(
                    claim_payment_response::Payload::InvalidTransaction(PaymentClaimNotice {
                        message: err.message().to_string(),
                    }),
                );
            }
        },
        None => None,
    };

    let pool_for_session = app_ctx.pool.clone();
    let now_unix = Utc::now().timestamp();
    let session_wallet_res = web::block(move || {
        let conn = pool_for_session.get().map_err(|err| {
            AuthError::internal("Database connection pool unavailable.", format!("{err:?}"))
        })?;
        get_valid_session_wallet(&conn, &token, now_unix)
    })
    .await;

    let wallet_address = match session_wallet_res {
        Ok(Ok(Some(w))) => w,
        Ok(Ok(None)) => {
            return claim_payment_proto_response(claim_payment_response::Payload::Unauthorized(
                PaymentClaimNotice {
                    message: "Session is invalid or expired.".to_string(),
                },
            ));
        }
        Ok(Err(err)) => return auth_error_to_response(err),
        Err(err) => {
            return auth_error_to_response(AuthError::internal(
                "Failed to resolve auth session.",
                format!("{err:?}"),
            ));
        }
    };

    let payment_verifier: Arc<dyn PaymentVerifier> = match verifier {
        Some(v) => v.get_ref().clone(),
        None => Arc::new(RpcPaymentVerifier::new(config.clone())),
    };

    let verified = match payment_verifier
        .verify_payment(&tx_hash, &wallet_address)
        .await
    {
        Ok(v) => v,
        Err(PaymentVerificationError::Pending(message)) => {
            return claim_payment_proto_response(claim_payment_response::Payload::Pending(
                PaymentClaimNotice { message },
            ));
        }
        Err(PaymentVerificationError::Reverted(message)) => {
            return claim_payment_proto_response(claim_payment_response::Payload::Reverted(
                PaymentClaimNotice { message },
            ));
        }
        Err(PaymentVerificationError::InvalidTransaction(message)) => {
            return claim_payment_proto_response(
                claim_payment_response::Payload::InvalidTransaction(PaymentClaimNotice { message }),
            );
        }
        Err(PaymentVerificationError::Internal { message, details }) => {
            return auth_error_to_response(AuthError::internal(message, details));
        }
    };

    let pool_for_claim = app_ctx.pool.clone();
    let claim_res = web::block(move || {
        let conn = pool_for_claim
            .get()
            .map_err(|err| ClaimPaymentDbError::Internal {
                message: "Database connection pool unavailable.".to_string(),
                details: format!("{err:?}"),
            })?;
        claim_payment_atomically(
            &conn,
            &wallet_address,
            normalized_nickname.as_deref(),
            &verified.tx_hash,
            &verified.amount_wei.to_string(),
            now_unix,
            verified.access_duration_secs,
        )
    })
    .await;

    match claim_res {
        Ok(Ok(profile)) => claim_payment_proto_response(
            claim_payment_response::Payload::Activated(auth_session_from_profile(profile, &config)),
        ),
        Ok(Err(ClaimPaymentDbError::NicknameTaken(message))) => claim_payment_proto_response(
            claim_payment_response::Payload::NicknameTaken(PaymentClaimNotice { message }),
        ),
        Ok(Err(ClaimPaymentDbError::InvalidTransaction(message))) => claim_payment_proto_response(
            claim_payment_response::Payload::InvalidTransaction(PaymentClaimNotice { message }),
        ),
        Ok(Err(ClaimPaymentDbError::Internal { message, details })) => {
            auth_error_to_response(AuthError::internal(message, details))
        }
        Err(err) => auth_error_to_response(AuthError::internal(
            "Failed to record claimed payment.",
            format!("{err:?}"),
        )),
    }
}

#[post("/auth/nickname")]
pub async fn post_auth_nickname_handler(
    req: HttpRequest,
    app_ctx: web::Data<AppCtx>,
    payment_cfg: Option<web::Data<PaymentConfig>>,
    body: web::Bytes,
) -> HttpResponse {
    let config = resolve_payment_config(payment_cfg);
    let Some(token) = extract_session_token(&req) else {
        return auth_error_to_response(AuthError::unauthorized(
            "UNAUTHORIZED",
            "Missing session cookie.",
        ));
    };

    let req_body = match SetNicknameRequest::decode(body.as_ref()) {
        Ok(decoded) => decoded,
        Err(_) => {
            return auth_error_to_response(AuthError::validation("Malformed nickname request."));
        }
    };

    let raw_nickname = req_body.nickname;
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
        let profile = get_wallet_profile(&conn, &wallet_address, now_unix)?;
        if !profile.has_active_access {
            return Err(AuthError::unauthorized(
                "PAYMENT_REQUIRED",
                "Active paid access is required to update nickname.",
            ));
        }
        set_wallet_nickname(&conn, &wallet_address, &raw_nickname, now_unix)
    })
    .await;

    match result {
        Ok(Ok(profile)) => proto_ok(auth_session_from_profile(profile, &config)),
        Ok(Err(err)) => auth_error_to_response(err),
        Err(err) => auth_error_to_response(AuthError::internal(
            "Failed to update wallet nickname.",
            format!("{err:?}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::db::init_auth_schema;
    use crate::auth::siwe::test_helpers::{sign_personal_message, wallet_address_from_private_key};
    use crate::auth::siwe::{SiweMessage, format_siwe_message};
    use actix_web::{App, http::StatusCode, test};
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

        // 1. POST /auth/nonce issues binary protobuf challenge
        let nonce_req = test::TestRequest::post()
            .uri("/auth/nonce")
            .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
            .set_payload(
                NonceRequest {
                    wallet_address: wallet.to_uppercase().replacen("0X", "0x", 1),
                }
                .encode_to_vec(),
            )
            .to_request();
        let nonce_resp = test::call_service(&app, nonce_req).await;
        assert_eq!(nonce_resp.status(), StatusCode::OK);
        assert_eq!(
            nonce_resp.headers().get(header::CONTENT_TYPE).unwrap(),
            PROTO_CONTENT_TYPE
        );
        let issued = NonceResponse::decode(test::read_body(nonce_resp).await.as_ref()).unwrap();
        let expected_checksum = to_checksum_address(&wallet).unwrap();
        assert_eq!(issued.wallet_address, expected_checksum);
        assert_eq!(issued.nonce.len(), 32);
        assert!(issued.siwe_message.starts_with(&format!(
            "erdmko.dev wants you to sign in with your Ethereum account:\n{expected_checksum}\n\n"
        )));

        // 2. Sign server-generated EIP-4361 message with PRIV_KEY_1
        let siwe_msg = issued.siwe_message.clone();
        let signature = sign_personal_message(&PRIV_KEY_1, &siwe_msg);

        // 3. POST /auth/verify sets HttpOnly cookie and returns protobuf AuthSession
        let verify_req = test::TestRequest::post()
            .uri("/auth/verify")
            .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
            .set_payload(
                VerifySiweRequest {
                    message: siwe_msg.clone(),
                    signature: signature.clone(),
                }
                .encode_to_vec(),
            )
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

        let status_body = AuthSession::decode(test::read_body(verify_resp).await.as_ref()).unwrap();
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
            .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
            .set_payload(
                VerifySiweRequest {
                    message: siwe_msg,
                    signature,
                }
                .encode_to_vec(),
            )
            .to_request();
        let replay_resp = test::call_service(&app, replay_req).await;
        assert_eq!(replay_resp.status(), StatusCode::UNAUTHORIZED);

        // 5. GET /auth/session with cookie returns wallet address via binary protobuf
        let session_req = test::TestRequest::get()
            .uri("/auth/session")
            .insert_header((header::COOKIE, cookie_pair.clone()))
            .to_request();
        let session_resp = test::call_service(&app, session_req).await;
        assert_eq!(session_resp.status(), StatusCode::OK);
        assert_eq!(
            session_resp.headers().get(header::CONTENT_TYPE).unwrap(),
            PROTO_CONTENT_TYPE
        );
        let resolved = AuthSession::decode(test::read_body(session_resp).await.as_ref()).unwrap();
        assert_eq!(resolved.wallet_address, wallet);

        // 6. POST /auth/logout revokes the session in SQLite
        let logout_req = test::TestRequest::post()
            .uri("/auth/logout")
            .insert_header((header::COOKIE, cookie_pair.clone()))
            .to_request();
        let logout_resp = test::call_service(&app, logout_req).await;
        assert_eq!(logout_resp.status(), StatusCode::OK);

        // 7. Subsequent GET /auth/session with the revoked cookie returns 200 with empty wallet_address
        let after_logout_req = test::TestRequest::get()
            .uri("/auth/session")
            .insert_header((header::COOKIE, cookie_pair))
            .to_request();
        let after_logout_resp = test::call_service(&app, after_logout_req).await;
        assert_eq!(after_logout_resp.status(), StatusCode::OK);
        let after_logout_body =
            AuthSession::decode(test::read_body(after_logout_resp).await.as_ref()).unwrap();
        assert!(after_logout_body.wallet_address.is_empty());
        assert!(!after_logout_body.has_active_access);
    }

    const PRIV_KEY_2: [u8; 32] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 2,
    ];

    struct MockVerifier {
        confirmed_tx: String,
        pending_tx: String,
        reverted_tx: String,
    }

    impl PaymentVerifier for MockVerifier {
        fn verify_payment<'a>(
            &'a self,
            tx_hash: &'a str,
            expected_sender_wallet: &'a str,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = crate::auth::payment::PaymentVerifyResult<
                            crate::auth::payment::VerifiedPayment,
                        >,
                    > + 'a,
            >,
        > {
            Box::pin(async move {
                let norm_tx = normalize_tx_hash(tx_hash)
                    .map_err(|err| PaymentVerificationError::invalid_transaction(err.message()))?;
                if norm_tx == self.pending_tx {
                    return Err(PaymentVerificationError::pending(
                        "Payment transaction is still pending confirmation.",
                    ));
                }
                if norm_tx == self.reverted_tx {
                    return Err(PaymentVerificationError::reverted(
                        "Payment transaction failed or reverted onchain.",
                    ));
                }
                if norm_tx != self.confirmed_tx {
                    return Err(PaymentVerificationError::invalid_transaction(
                        "unknown transaction hash",
                    ));
                }
                Ok(crate::auth::payment::VerifiedPayment {
                    tx_hash: norm_tx,
                    from_wallet: expected_sender_wallet.to_string(),
                    to_wallet: crate::auth::RECIPIENT_WALLET_ADDRESS.to_string(),
                    amount_wei: 1_000_000_000_000_000,
                    access_duration_secs: crate::auth::DEFAULT_ACCESS_DURATION_SECS,
                })
            })
        }
    }

    #[actix_web::test]
    async fn claim_payment_extends_access_sets_nickname_and_rejects_replay() {
        let ctx = setup_test_ctx();
        let tx_hash =
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_string();
        let pending_tx_hash =
            "0x1111111111111111111111111111111111111111111111111111111111111111".to_string();
        let reverted_tx_hash =
            "0x2222222222222222222222222222222222222222222222222222222222222222".to_string();
        let verifier: Arc<dyn PaymentVerifier> = Arc::new(MockVerifier {
            confirmed_tx: tx_hash.clone(),
            pending_tx: pending_tx_hash.clone(),
            reverted_tx: reverted_tx_hash.clone(),
        });

        let app = test::init_service(
            App::new()
                .app_data(ctx.clone())
                .app_data(web::Data::new(verifier))
                .service(post_auth_claim_payment_handler)
                .service(post_auth_nickname_handler),
        )
        .await;

        let wallet = wallet_address_from_private_key(&PRIV_KEY_1);
        let wallet_bob = wallet_address_from_private_key(&PRIV_KEY_2);
        let now_unix = Utc::now().timestamp();
        let (session, session_bob) = {
            let conn = ctx.pool.get().unwrap();
            set_wallet_nickname(&conn, &wallet_bob, "taken_nick", now_unix).unwrap();
            (
                create_session(&conn, &wallet, now_unix, SESSION_TTL_SECS).unwrap(),
                create_session(&conn, &wallet_bob, now_unix, SESSION_TTL_SECS).unwrap(),
            )
        };
        let cookie_header = format!("{SESSION_COOKIE_NAME}={}", session.token);
        let bob_cookie_header = format!("{SESSION_COOKIE_NAME}={}", session_bob.token);

        // Unpaid wallet cannot call POST /auth/nickname before claiming payment
        let early_nick_req = test::TestRequest::post()
            .uri("/auth/nickname")
            .insert_header((header::COOKIE, cookie_header.clone()))
            .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
            .set_payload(
                SetNicknameRequest {
                    nickname: "alice_eth".to_string(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let early_nick_resp = test::call_service(&app, early_nick_req).await;
        assert_eq!(early_nick_resp.status(), StatusCode::UNAUTHORIZED);

        // 0a. Missing session cookie returns protobuf Unauthorized variant
        let unauth_req = test::TestRequest::post()
            .uri("/auth/claim-payment")
            .set_payload(
                ClaimPaymentRequest {
                    tx_hash: tx_hash.clone(),
                    nickname: "alice_eth".to_string(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let unauth_resp = test::call_service(&app, unauth_req).await;
        assert_eq!(unauth_resp.status(), StatusCode::OK);
        let unauth_proto =
            ClaimPaymentResponse::decode(test::read_body(unauth_resp).await.as_ref()).unwrap();
        assert!(matches!(
            unauth_proto.payload,
            Some(claim_payment_response::Payload::Unauthorized(_))
        ));

        // 0b. Pending transaction returns protobuf Pending variant
        let pending_req = test::TestRequest::post()
            .uri("/auth/claim-payment")
            .insert_header((header::COOKIE, cookie_header.clone()))
            .set_payload(
                ClaimPaymentRequest {
                    tx_hash: pending_tx_hash,
                    nickname: "alice_eth".to_string(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let pending_resp = test::call_service(&app, pending_req).await;
        let pending_proto =
            ClaimPaymentResponse::decode(test::read_body(pending_resp).await.as_ref()).unwrap();
        assert!(matches!(
            pending_proto.payload,
            Some(claim_payment_response::Payload::Pending(_))
        ));

        // 0c. Reverted transaction returns protobuf Reverted variant
        let reverted_req = test::TestRequest::post()
            .uri("/auth/claim-payment")
            .insert_header((header::COOKIE, cookie_header.clone()))
            .set_payload(
                ClaimPaymentRequest {
                    tx_hash: reverted_tx_hash,
                    nickname: "alice_eth".to_string(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let reverted_resp = test::call_service(&app, reverted_req).await;
        let reverted_proto =
            ClaimPaymentResponse::decode(test::read_body(reverted_resp).await.as_ref()).unwrap();
        assert!(matches!(
            reverted_proto.payload,
            Some(claim_payment_response::Payload::Reverted(_))
        ));

        // 0d. NicknameTaken returns protobuf NicknameTaken variant and does NOT consume tx_hash
        let taken_req = test::TestRequest::post()
            .uri("/auth/claim-payment")
            .insert_header((header::COOKIE, cookie_header.clone()))
            .set_payload(
                ClaimPaymentRequest {
                    tx_hash: tx_hash.clone(),
                    nickname: "taken_nick".to_string(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let taken_resp = test::call_service(&app, taken_req).await;
        let taken_proto =
            ClaimPaymentResponse::decode(test::read_body(taken_resp).await.as_ref()).unwrap();
        assert!(matches!(
            taken_proto.payload,
            Some(claim_payment_response::Payload::NicknameTaken(_))
        ));

        // 1. First payment claim with free nickname succeeds, extends access_until, and sets nickname
        let claim_req = test::TestRequest::post()
            .uri("/auth/claim-payment")
            .insert_header((header::COOKIE, cookie_header.clone()))
            .set_payload(
                ClaimPaymentRequest {
                    tx_hash: tx_hash.clone(),
                    nickname: "alice_eth".to_string(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let claim_resp = test::call_service(&app, claim_req).await;
        assert_eq!(claim_resp.status(), StatusCode::OK);
        let claim_proto =
            ClaimPaymentResponse::decode(test::read_body(claim_resp).await.as_ref()).unwrap();
        let claimed_status = match claim_proto.payload {
            Some(claim_payment_response::Payload::Activated(activated)) => activated,
            other => panic!("expected Activated variant, got {other:?}"),
        };
        assert_eq!(claimed_status.wallet_address, wallet);
        assert_eq!(claimed_status.nickname, "alice_eth");
        assert!(claimed_status.has_active_access);
        assert!(claimed_status.access_until > now_unix);
        assert!(claimed_status.payment_config.is_some());

        // 2a. Same-wallet retry with the same txHash returns Activated idempotently without extending access_until again
        let retry_req = test::TestRequest::post()
            .uri("/auth/claim-payment")
            .insert_header((header::COOKIE, cookie_header.clone()))
            .set_payload(
                ClaimPaymentRequest {
                    tx_hash: tx_hash.clone(),
                    nickname: String::new(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let retry_resp = test::call_service(&app, retry_req).await;
        let retry_proto =
            ClaimPaymentResponse::decode(test::read_body(retry_resp).await.as_ref()).unwrap();
        let retry_status = match retry_proto.payload {
            Some(claim_payment_response::Payload::Activated(activated)) => activated,
            other => panic!("expected Activated on same-wallet retry, got {other:?}"),
        };
        assert_eq!(retry_status.access_until, claimed_status.access_until);
        assert_eq!(retry_status.nickname, "alice_eth");

        // 2b. Another wallet replaying the same txHash is rejected with InvalidTransaction
        let replay_req = test::TestRequest::post()
            .uri("/auth/claim-payment")
            .insert_header((header::COOKIE, bob_cookie_header))
            .set_payload(
                ClaimPaymentRequest {
                    tx_hash,
                    nickname: String::new(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let replay_resp = test::call_service(&app, replay_req).await;
        let replay_proto =
            ClaimPaymentResponse::decode(test::read_body(replay_resp).await.as_ref()).unwrap();
        assert!(matches!(
            replay_proto.payload,
            Some(claim_payment_response::Payload::InvalidTransaction(_))
        ));

        // 3. Paid wallet can update its nickname via POST /auth/nickname
        let update_nick_req = test::TestRequest::post()
            .uri("/auth/nickname")
            .insert_header((header::COOKIE, cookie_header))
            .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
            .set_payload(
                SetNicknameRequest {
                    nickname: "alice_v2".to_string(),
                }
                .encode_to_vec(),
            )
            .to_request();
        let update_nick_resp = test::call_service(&app, update_nick_req).await;
        assert_eq!(update_nick_resp.status(), StatusCode::OK);
        let updated_status =
            AuthSession::decode(test::read_body(update_nick_resp).await.as_ref()).unwrap();
        assert_eq!(updated_status.nickname, "alice_v2");
    }

    #[actix_web::test]
    async fn exposes_effective_payment_config_and_enforces_siwe_chain_id() {
        let ctx = setup_test_ctx();
        let custom_cfg = PaymentConfig {
            chain_id: 11_155_111,
            rpc_url: "https://ethereum-sepolia-rpc.publicnode.com".to_string(),
            recipient_address: "0x2222222222222222222222222222222222222222".to_string(),
            min_payment_wei: 2_000_000_000_000_000, // 0.002 ETH = 0x71afd498d0000
            access_duration_secs: 7 * 24 * 60 * 60,
        };
        let app = test::init_service(
            App::new()
                .app_data(ctx.clone())
                .app_data(web::Data::new(custom_cfg.clone()))
                .service(post_auth_nonce_handler)
                .service(post_auth_verify_handler)
                .service(get_auth_session_handler),
        )
        .await;

        // 1. Unauthenticated /auth/session includes public payment config without exposing rpc_url
        let unauth_resp = test::call_service(
            &app,
            test::TestRequest::get().uri("/auth/session").to_request(),
        )
        .await;
        assert_eq!(unauth_resp.status(), StatusCode::OK);
        let unauth_bytes = test::read_body(unauth_resp).await;
        assert!(
            !String::from_utf8_lossy(&unauth_bytes).contains("publicnode"),
            "rpc_url must never be serialized into /auth/session protobuf bytes"
        );
        let unauth_proto = AuthSession::decode(unauth_bytes.as_ref()).unwrap();
        assert!(unauth_proto.wallet_address.is_empty());
        let session_cfg = unauth_proto.payment_config.expect("payment_config present");
        assert_eq!(session_cfg.chain_id, 11_155_111);
        assert_eq!(
            session_cfg.recipient_address,
            "0x2222222222222222222222222222222222222222"
        );
        assert_eq!(session_cfg.min_payment_wei, "0x71afd498d0000");
        assert_eq!(session_cfg.access_duration_secs, 7 * 24 * 60 * 60);

        // 2. /auth/nonce includes matching payment config
        let wallet = wallet_address_from_private_key(&PRIV_KEY_1);
        let nonce_resp = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/auth/nonce")
                .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
                .set_payload(
                    NonceRequest {
                        wallet_address: wallet.clone(),
                    }
                    .encode_to_vec(),
                )
                .to_request(),
        )
        .await;
        let issued = NonceResponse::decode(test::read_body(nonce_resp).await.as_ref()).unwrap();
        let nonce_cfg = issued.payment_config.expect("payment_config present");
        assert_eq!(nonce_cfg.chain_id, 11_155_111);
        assert_eq!(
            nonce_cfg.recipient_address,
            "0x2222222222222222222222222222222222222222"
        );
        assert_eq!(nonce_cfg.min_payment_wei, "0x71afd498d0000");

        // 3. /auth/verify rejects SIWE message signed for wrong chain ID (1 instead of 11155111)
        let now = Utc::now();
        let wrong_chain_msg = format_siwe_message(&SiweMessage {
            domain: "erdmko.dev".to_string(),
            address: wallet.clone(),
            statement: Some("Sign in to month.erdmko.de".to_string()),
            uri: "https://erdmko.dev/chat/general".to_string(),
            version: "1".to_string(),
            chain_id: 1,
            nonce: issued.nonce.clone(),
            issued_at: now.to_rfc3339(),
            expiration_time: None,
            not_before: None,
            request_id: None,
        });
        let wrong_sig = sign_personal_message(&PRIV_KEY_1, &wrong_chain_msg);
        let wrong_verify_resp = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/auth/verify")
                .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
                .set_payload(
                    VerifySiweRequest {
                        message: wrong_chain_msg,
                        signature: wrong_sig,
                    }
                    .encode_to_vec(),
                )
                .to_request(),
        )
        .await;
        assert_eq!(wrong_verify_resp.status(), StatusCode::UNAUTHORIZED);
        let wrong_err =
            PaymentClaimNotice::decode(test::read_body(wrong_verify_resp).await.as_ref()).unwrap();
        assert!(wrong_err.message.contains("Chain ID"));

        // 4. /auth/verify accepts the server-generated SIWE message signed for configured chain ID (11155111)
        assert!(issued.siwe_message.contains("Chain ID: 11155111\n"));
        let right_chain_msg = issued.siwe_message;
        let right_sig = sign_personal_message(&PRIV_KEY_1, &right_chain_msg);
        let right_verify_resp = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/auth/verify")
                .insert_header((header::CONTENT_TYPE, PROTO_CONTENT_TYPE))
                .set_payload(
                    VerifySiweRequest {
                        message: right_chain_msg,
                        signature: right_sig,
                    }
                    .encode_to_vec(),
                )
                .to_request(),
        )
        .await;
        assert_eq!(right_verify_resp.status(), StatusCode::OK);
        let verified_status =
            AuthSession::decode(test::read_body(right_verify_resp).await.as_ref()).unwrap();
        let verified_cfg = verified_status
            .payment_config
            .expect("payment_config present");
        assert_eq!(verified_cfg.chain_id, 11_155_111);
        assert_eq!(
            verified_cfg.recipient_address,
            "0x2222222222222222222222222222222222222222"
        );
        assert_eq!(verified_cfg.min_payment_wei, "0x71afd498d0000");
    }
}
