use actix::{Actor, StreamHandler};
use actix_web::{get, web, HttpRequest, HttpResponse, Result, Error};
use actix_web_actors::ws;
use tera::Context;

use super::utils;
use crate::app::AppCtx;
use crate::db::query;

#[get("/tetris")]
pub async fn tetris_page_handler(
    app_ctx: web::Data<AppCtx>,
    req: HttpRequest,
) -> Result<HttpResponse> {
    let mut ctx = Context::new();
    ctx.insert("game_name", "Tetris");
    ctx.insert("bundle_name", "tetris");
    let query_result = query(app_ctx).await;
    if let Ok(res) = &query_result {
        ctx.insert("result", &format!("{:?}", res));
    }
    return utils::render(req, "js_bundle_page.html", &ctx).await;
}

struct AppWs;

impl Actor for AppWs {
    type Context = ws::WebsocketContext<Self>;
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for AppWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Text(text)) => ctx.text(text),
            Ok(ws::Message::Binary(bin)) => ctx.binary(bin),
            _ => (),
        }
    }
}

#[get("/ws")]
pub async fn ws_page_handler(req: HttpRequest, stream: web::Payload) -> Result<HttpResponse, Error> {
    let resp = ws::start(AppWs {}, &req, stream);
    println!("{:?}", resp);
    resp
}

#[get("/tennis")]
pub async fn tennis_page_handler(
    req: HttpRequest,
) -> Result<HttpResponse> {
    let mut ctx = Context::new();
    ctx.insert("game_name", "Tennis");
    ctx.insert("bundle_name", "tennis");
    return utils::render(req, "js_bundle_page.html", &ctx).await;
}
