use actix_web::http::header;
use actix_web::{Error, HttpRequest, HttpResponse, Result, get, web};
use actix_web_actors::ws;
use log::warn;
use rand::random;
use serde::{Deserialize, Serialize};
use tera::Context;

use super::utils;
use crate::app::AppCtx;
use crate::attachments::service::UploadSessionState;
use crate::chat::service::{self as chat_service, ChatSessionState};

pub(crate) mod chat_actor;
mod dispatch;

use chat_actor::ChatWs;

#[derive(Serialize)]
pub struct FeaturedRoom {
    pub slug: &'static str,
    pub title: &'static str,
    pub description: &'static str,
}

pub const PUBLIC_CHAT_ROOMS: &[FeaturedRoom] = &[
    FeaturedRoom {
        slug: "general",
        title: "General Lobby",
        description: "Open community room for general discussion, quick messages, and voice tests.",
    },
    FeaturedRoom {
        slug: "rust",
        title: "Rust & Systems",
        description: "Actix Web, Bazel builds, GStreamer pipelines, and systems programming.",
    },
    FeaturedRoom {
        slug: "web3",
        title: "Web3 & Ethereum",
        description: "Sign-In with Ethereum (SIWE), wallet identity, and browser cryptography.",
    },
    FeaturedRoom {
        slug: "voice",
        title: "Voice Lounge",
        description: "Low-latency WebRTC Opus voice channel for testing audio and group calls.",
    },
];

pub fn is_public_chat_room(room_id: &str) -> bool {
    PUBLIC_CHAT_ROOMS.iter().any(|r| r.slug == room_id)
}

#[derive(Deserialize)]
pub struct ChatLandingQuery {
    pub room: Option<String>,
}

fn sanitize_room_slug(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 64 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

fn has_active_paid_session(req: &HttpRequest) -> bool {
    let Some(app_ctx) = req.app_data::<web::Data<AppCtx>>() else {
        return false;
    };
    let Some(token) = crate::pages::auth::extract_session_token(req) else {
        return false;
    };
    let Ok(conn) = app_ctx.pool.get() else {
        return false;
    };
    let now_unix = chrono::Utc::now().timestamp();
    let Ok(Some(wallet)) = crate::auth::db::get_valid_session_wallet(&conn, &token, now_unix)
    else {
        return false;
    };
    let Ok(profile) = crate::auth::db::get_wallet_profile(&conn, &wallet, now_unix) else {
        return false;
    };
    profile.has_active_access
}

#[get("/chat")]
pub async fn chat_landing_page_handler(
    req: HttpRequest,
    query: web::Query<ChatLandingQuery>,
) -> Result<HttpResponse> {
    let target_room = query
        .room
        .as_deref()
        .map(sanitize_room_slug)
        .unwrap_or_default();
    if !target_room.is_empty() && has_active_paid_session(&req) {
        return Ok(HttpResponse::SeeOther()
            .insert_header((header::LOCATION, format!("/chat/{target_room}")))
            .finish());
    }
    let mut ctx = Context::new();
    ctx.insert("featured_rooms", PUBLIC_CHAT_ROOMS);
    ctx.insert("target_room", &target_room);
    ctx.insert("bundle_name", "chat");
    utils::render(req, "chat_landing.html", &ctx).await
}

#[get("/chat/{room_id}")]
pub async fn chat_room_page_handler(
    req: HttpRequest,
    room_id: web::Path<String>,
) -> Result<HttpResponse> {
    let room = room_id.into_inner();
    if !has_active_paid_session(&req) {
        let slug = sanitize_room_slug(&room);
        let location = if slug.is_empty() {
            "/chat".to_string()
        } else {
            format!("/chat?room={slug}")
        };
        return Ok(HttpResponse::SeeOther()
            .insert_header((header::LOCATION, location))
            .finish());
    }
    let mut ctx = Context::new();
    ctx.insert("is_public_room", &is_public_chat_room(&room));
    ctx.insert("room_id", &room);
    ctx.insert("bundle_name", "chat");
    utils::render(req, "chat.html", &ctx).await
}

#[get("/ws/chat/{room_id}")]
pub async fn chat_ws_page_handler(
    req: HttpRequest,
    stream: web::Payload,
    room_id: web::Path<String>,
) -> Result<HttpResponse, Error> {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let Some(origin) = origin else {
        warn!(
            "event=chat_error room_id={} sender_id=null code=FORBIDDEN_ORIGIN request_id=null error=missing_origin",
            room_id.as_str()
        );
        return Err(actix_web::error::ErrorForbidden("Origin is required."));
    };
    if !chat_service::is_allowed_origin(origin) {
        warn!(
            "event=chat_error room_id={} sender_id=null code=FORBIDDEN_ORIGIN request_id=null error=origin_not_allowed origin={}",
            room_id.as_str(),
            origin
        );
        return Err(actix_web::error::ErrorForbidden("Origin is not allowed."));
    }
    let app_ctx = req
        .app_data::<web::Data<AppCtx>>()
        .cloned()
        .ok_or_else(|| actix_web::error::ErrorInternalServerError("app context is missing"))?;
    let room_id = room_id.into_inner();
    let now_unix = chrono::Utc::now().timestamp();
    let verified_wallet = crate::pages::auth::extract_session_token(&req).and_then(|token| {
        let conn = app_ctx.pool.get().ok()?;
        crate::auth::db::get_valid_session_wallet(&conn, &token, now_unix)
            .ok()
            .flatten()
    });
    let sender_id = verified_wallet.unwrap_or_else(|| format!("anon-{:x}", random::<u64>()));

    ws::WsResponseBuilder::new(
        ChatWs {
            app_ctx,
            room_id,
            sender_id,
            session: ChatSessionState::new(),
            is_registered: false,
            uploads: UploadSessionState::new(),
            hb: std::time::Instant::now(),
        },
        &req,
        stream,
    )
    .frame_size(chat_service::WS_FRAME_MAX_BYTES)
    .start()
}

#[cfg(test)]
mod tests;
