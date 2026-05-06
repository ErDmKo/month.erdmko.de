use actix_web::http::header;
use actix_web::{Error, HttpRequest, HttpResponse, Result, get, web};
use actix_web_actors::ws;
use log::warn;
use rand::random;
use tera::Context;

use super::utils;
use crate::app::AppCtx;
use crate::attachments::service::UploadSessionState;
use crate::chat::service::{self as chat_service, ChatSessionState};

mod actor;
use actor::ChatWs;

#[get("/chat/{room_id}")]
pub async fn chat_room_page_handler(
    req: HttpRequest,
    room_id: web::Path<String>,
) -> Result<HttpResponse> {
    let mut ctx = Context::new();
    let room = room_id.into_inner();
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
    let sender_id = format!("anon-{:x}", random::<u64>());

    ws::WsResponseBuilder::new(
        ChatWs {
            app_ctx,
            room_id,
            sender_id,
            session: ChatSessionState::new(),
            is_registered: false,
            uploads: UploadSessionState::new(),
        },
        &req,
        stream,
    )
    .frame_size(chat_service::WS_FRAME_MAX_BYTES)
    .start()
}

#[cfg(test)]
mod tests;
