mod attachments;
mod helpers;
mod messaging;
mod voice;

use super::{is_public_chat_room, sanitize_room_slug};
use crate::pages::sitemap_xml_handler;
use actix_web::{App, http::StatusCode, test};

#[actix_web::test]
async fn room_slug_sanitization_and_public_room_classification() {
    assert_eq!(sanitize_room_slug("  rust devs 2026! "), "rust-devs-2026");
    assert_eq!(sanitize_room_slug("my_room-1"), "my_room-1");
    assert_eq!(sanitize_room_slug("   ---   "), "");
    assert!(is_public_chat_room("general"));
    assert!(is_public_chat_room("rust"));
    assert!(!is_public_chat_room("secret-room-42"));
}

#[actix_web::test]
async fn sitemap_xml_includes_chat_landing_and_public_rooms() {
    let app = test::init_service(App::new().service(sitemap_xml_handler)).await;
    let req = test::TestRequest::get().uri("/sitemap.xml").to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = test::read_body(resp).await;
    let xml = std::str::from_utf8(&body).expect("utf-8 xml");
    assert!(xml.contains("<loc>https://erdmko.dev/chat</loc>"));
    assert!(xml.contains("<loc>https://erdmko.dev/chat/general</loc>"));
    assert!(xml.contains("<loc>https://erdmko.dev/chat/rust</loc>"));
}
