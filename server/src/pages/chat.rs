use actix::{Actor, StreamHandler};
use actix_web::{get, web, Error, HttpRequest, HttpResponse, Result};
use actix_web_actors::ws;

use crate::chat::{MAX_MESSAGE_LEN, WS_MAX_PAYLOAD_BYTES};

struct ChatWs;

impl Actor for ChatWs {
    type Context = ws::WebsocketContext<Self>;
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for ChatWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Text(text)) => {
                if text.chars().count() <= MAX_MESSAGE_LEN {
                    ctx.text(text);
                } else {
                    ctx.text("message too long");
                }
            }
            Ok(ws::Message::Binary(bin)) => ctx.binary(bin),
            Ok(ws::Message::Close(reason)) => ctx.close(reason),
            _ => (),
        }
    }
}

#[get("/chat/{room_id}")]
pub async fn chat_room_page_handler(room_id: web::Path<String>) -> Result<HttpResponse> {
    Ok(HttpResponse::Ok().body(format!("Chat room stub: {}", room_id.into_inner())))
}

#[get("/ws/chat/{room_id}")]
pub async fn chat_ws_page_handler(
    req: HttpRequest,
    stream: web::Payload,
    room_id: web::Path<String>,
) -> Result<HttpResponse, Error> {
    let _ = room_id;
    ws::WsResponseBuilder::new(ChatWs {}, &req, stream)
        .frame_size(WS_MAX_PAYLOAD_BYTES)
        .start()
}
