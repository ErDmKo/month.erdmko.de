use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, get, post, web};
use chrono::Utc;
use prost::Message;
use serde::{Deserialize, Serialize};

use crate::app::AppCtx;
use crate::auth::db::{
    ClaimPaymentDbError, WalletProfile, claim_payment_atomically, create_session,
    get_valid_session_wallet, get_wallet_profile, issue_nonce, revoke_session, set_wallet_nickname,
};
use crate::auth::error::{AuthError, AuthErrorKind};
use crate::auth::payment::{PaymentVerificationError, PaymentVerifier, RpcPaymentVerifier};
use crate::auth::service::{normalize_tx_hash, validate_ascii_nickname};
use crate::auth::siwe::verify_siwe_and_consume_nonce;
use crate::auth::{NONCE_TTL_SECS, SESSION_COOKIE_NAME, SESSION_TTL_SECS};
use crate::generated::chat::{
    ClaimPaymentRequest, ClaimPaymentResponse, PaymentClaimActivated, PaymentClaimNotice,
    claim_payment_response,
};
use std::sync::Arc;

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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNicknameRequest {
    pub nickname: String,
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
        return HttpResponse::Ok().json(serde_json::json!({ "authenticated": false }));
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
        Ok(Ok(Some(profile))) => HttpResponse::Ok().json(SessionStatusResponse::from(profile)),
        Ok(Ok(None)) => HttpResponse::Ok().json(serde_json::json!({ "authenticated": false })),
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

fn claim_payment_proto_response(payload: claim_payment_response::Payload) -> HttpResponse {
    let bytes = ClaimPaymentResponse {
        payload: Some(payload),
    }
    .encode_to_vec();
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "application/x-protobuf"))
        .body(bytes)
}

#[post("/auth/claim-payment")]
pub async fn post_auth_claim_payment_handler(
    req: HttpRequest,
    app_ctx: web::Data<AppCtx>,
    verifier: Option<web::Data<Arc<dyn PaymentVerifier>>>,
    body: web::Bytes,
) -> HttpResponse {
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
        None => Arc::new(RpcPaymentVerifier::from_env()),
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
            claim_payment_response::Payload::Activated(PaymentClaimActivated {
                wallet_address: profile.wallet_address,
                nickname: profile.nickname.unwrap_or_default(),
                access_until: profile.access_until,
                has_active_access: profile.has_active_access,
            }),
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
    payload: web::Json<SetNicknameRequest>,
) -> HttpResponse {
    let Some(token) = extract_session_token(&req) else {
        return auth_error_to_response(AuthError::unauthorized(
            "UNAUTHORIZED",
            "Missing session cookie.",
        ));
    };

    let raw_nickname = payload.into_inner().nickname;
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
        Ok(Ok(profile)) => HttpResponse::Ok().json(SessionStatusResponse::from(profile)),
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

        // 7. Subsequent GET /auth/session with the revoked cookie returns 200 with authenticated=false
        let after_logout_req = test::TestRequest::get()
            .uri("/auth/session")
            .insert_header((header::COOKIE, cookie_pair))
            .to_request();
        let after_logout_resp = test::call_service(&app, after_logout_req).await;
        assert_eq!(after_logout_resp.status(), StatusCode::OK);
        let after_logout_body: serde_json::Value = test::read_body_json(after_logout_resp).await;
        assert_eq!(after_logout_body["authenticated"], serde_json::json!(false));
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
            .set_json(SetNicknameRequest {
                nickname: "alice_eth".to_string(),
            })
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
            .set_json(SetNicknameRequest {
                nickname: "alice_v2".to_string(),
            })
            .to_request();
        let update_nick_resp = test::call_service(&app, update_nick_req).await;
        assert_eq!(update_nick_resp.status(), StatusCode::OK);
        let updated_status: SessionStatusResponse = test::read_body_json(update_nick_resp).await;
        assert_eq!(updated_status.nickname.as_deref(), Some("alice_v2"));
    }
}
