use super::helpers::*;
use rand::random;

#[actix_web::test]
async fn join_sends_joined_and_history() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_id)
        .await
        .expect("room should be created");
    chat_db::insert_message(&ctx, &room_id, "u1", "alice", "hello history")
        .await
        .expect("message should be inserted");

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let addr = listener.local_addr().expect("listener local addr");
    let server_ctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_ctx.clone())
            .service(chat_ws_page_handler)
    })
    .listen(listener)
    .expect("listen should succeed")
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let ws_url = format!("ws://{}/ws/chat/{}", addr, room_id);
    let (_resp, mut ws) = awc::Client::new()
        .ws(ws_url)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws connect should succeed");
    ws.send(awc::ws::Message::Text(
        json!({
            "type": "join",
            "requestId": "r1",
            "nickname": "dima"
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("join should be sent");

    let first = read_next_text(&mut ws).await;
    let second = read_next_text(&mut ws).await;
    let events = vec![first, second];
    assert!(events.iter().any(|e| e["type"] == "joined"));
    let history = events
        .iter()
        .find(|e| e["type"] == "history")
        .expect("history event should exist");
    assert!(
        history["items"]
            .as_array()
            .expect("history items should be array")
            .iter()
            .any(|item| item["body"] == "hello history")
    );

    handle.stop(true).await;
}

#[actix_web::test]
async fn message_broadcasts_only_inside_room() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let other_room = format!("room-{}", random::<u64>());

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let addr = listener.local_addr().expect("listener local addr");
    let server_ctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_ctx.clone())
            .service(chat_ws_page_handler)
    })
    .listen(listener)
    .expect("listen should succeed")
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let ws_url_1 = format!("ws://{}/ws/chat/{}", addr, room_id);
    let ws_url_2 = format!("ws://{}/ws/chat/{}", addr, room_id);
    let ws_url_other = format!("ws://{}/ws/chat/{}", addr, other_room);
    let (_resp1, mut ws1) = awc::Client::new()
        .ws(ws_url_1)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws1 connect should succeed");
    let (_resp2, mut ws2) = awc::Client::new()
        .ws(ws_url_2)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws2 connect should succeed");
    let (_resp_other, mut ws_other) = awc::Client::new()
        .ws(ws_url_other)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws_other connect should succeed");

    ws1.send(awc::ws::Message::Text(
        json!({"type":"join","nickname":"alice"}).to_string().into(),
    ))
    .await
    .expect("join ws1");
    ws2.send(awc::ws::Message::Text(
        json!({"type":"join","nickname":"bob"}).to_string().into(),
    ))
    .await
    .expect("join ws2");
    ws_other
        .send(awc::ws::Message::Text(
            json!({"type":"join","nickname":"charlie"})
                .to_string()
                .into(),
        ))
        .await
        .expect("join ws_other");

    let _ = read_next_text(&mut ws1).await;
    let _ = read_next_text(&mut ws1).await;
    let _ = read_next_text(&mut ws2).await;
    let _ = read_next_text(&mut ws2).await;
    let _ = read_next_text(&mut ws_other).await;
    let _ = read_next_text(&mut ws_other).await;

    ws1.send(awc::ws::Message::Text(
        json!({"type":"message","body":"hello room"})
            .to_string()
            .into(),
    ))
    .await
    .expect("message send should succeed");

    let incoming1 = read_next_text(&mut ws1).await;
    let incoming2 = read_next_text(&mut ws2).await;
    assert_eq!(incoming1["type"], "message");
    assert_eq!(incoming2["type"], "message");
    assert_eq!(incoming1["item"]["body"], "hello room");
    assert_eq!(incoming2["item"]["body"], "hello room");

    let other_result =
        actix_web::rt::time::timeout(Duration::from_millis(300), ws_other.next()).await;
    assert!(
        other_result.is_err(),
        "other room should not receive broadcast"
    );

    handle.stop(true).await;
}

#[actix_web::test]
async fn oversized_payload_returns_bad_payload_and_connection_survives() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let addr = listener.local_addr().expect("listener local addr");
    let server_ctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_ctx.clone())
            .service(chat_ws_page_handler)
    })
    .listen(listener)
    .expect("listen should succeed")
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let ws_url = format!("ws://{}/ws/chat/{}", addr, room_id);
    let (_resp, mut ws) = awc::Client::new()
        .ws(ws_url)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws connect should succeed");

    let oversized = json!({
        "type": "message",
        "requestId": "too-big",
        "body": "x".repeat(WS_MAX_PAYLOAD_BYTES),
    })
    .to_string();
    ws.send(awc::ws::Message::Text(oversized.into()))
        .await
        .expect("oversized message should be sent");
    let bad_payload = read_next_text(&mut ws).await;
    assert_eq!(bad_payload["type"], "error");
    assert_eq!(bad_payload["code"], "BAD_PAYLOAD");

    ws.send(awc::ws::Message::Text(
        json!({
            "type": "join",
            "requestId": "join-after-oversized",
            "nickname": "dima"
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("join should be sent");
    let first = read_next_text(&mut ws).await;
    let second = read_next_text(&mut ws).await;
    assert!(
        first["type"] == "joined" || second["type"] == "joined",
        "connection should remain alive after bad payload"
    );

    handle.stop(true).await;
}

#[actix_web::test]
async fn rate_limit_returns_rate_limited_error() {
    use crate::chat::service as chat_service;

    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let addr = listener.local_addr().expect("listener local addr");
    let server_ctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_ctx.clone())
            .service(chat_ws_page_handler)
    })
    .listen(listener)
    .expect("listen should succeed")
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let ws_url = format!("ws://{}/ws/chat/{}", addr, room_id);
    let (_resp, mut ws) = awc::Client::new()
        .ws(ws_url)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws connect should succeed");

    ws.send(awc::ws::Message::Text(
        json!({
            "type": "join",
            "requestId": "join-rate",
            "nickname": "alice"
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("join should be sent");
    let _ = read_next_text(&mut ws).await;
    let _ = read_next_text(&mut ws).await;

    for i in 0..(chat_service::RATE_LIMIT_MAX_MESSAGES + 1) {
        ws.send(awc::ws::Message::Text(
            json!({
                "type": "message",
                "requestId": format!("msg-{i}"),
                "body": format!("hello-{i}")
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("message should be sent");
    }

    let mut rate_limited = false;
    for _ in 0..(chat_service::RATE_LIMIT_MAX_MESSAGES + 2) {
        let incoming = read_next_text(&mut ws).await;
        if incoming["type"] == "error" && incoming["code"] == "RATE_LIMITED" {
            rate_limited = true;
            break;
        }
    }
    assert!(rate_limited, "rate limit should trigger RATE_LIMITED error");

    handle.stop(true).await;
}

#[actix_web::test]
async fn malformed_payload_does_not_break_connection() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let addr = listener.local_addr().expect("listener local addr");
    let server_ctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_ctx.clone())
            .service(chat_ws_page_handler)
    })
    .listen(listener)
    .expect("listen should succeed")
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let ws_url = format!("ws://{}/ws/chat/{}", addr, room_id);
    let (_resp, mut ws) = awc::Client::new()
        .ws(ws_url)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws connect should succeed");

    ws.send(awc::ws::Message::Text("not-json".into()))
        .await
        .expect("malformed payload should be sent");
    let bad_payload = read_next_text(&mut ws).await;
    assert_eq!(bad_payload["type"], "error");
    assert_eq!(bad_payload["code"], "BAD_PAYLOAD");

    ws.send(awc::ws::Message::Text(
        json!({
            "type": "join",
            "requestId": "join-after-bad-json",
            "nickname": "alice"
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("join should be sent");
    let first = read_next_text(&mut ws).await;
    let second = read_next_text(&mut ws).await;
    assert!(
        first["type"] == "joined" || second["type"] == "joined",
        "socket should remain usable after malformed payload"
    );

    handle.stop(true).await;
}

#[actix_web::test]
async fn delete_broadcasts_deleted_event_to_room_clients() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let addr = listener.local_addr().expect("listener local addr");
    let server_ctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_ctx.clone())
            .service(chat_ws_page_handler)
    })
    .listen(listener)
    .expect("listen should succeed")
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let ws_url_1 = format!("ws://{}/ws/chat/{}", addr, room_id);
    let ws_url_2 = format!("ws://{}/ws/chat/{}", addr, room_id);
    let (_resp1, mut ws1) = awc::Client::new()
        .ws(ws_url_1)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws1 connect should succeed");
    let (_resp2, mut ws2) = awc::Client::new()
        .ws(ws_url_2)
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .expect("ws2 connect should succeed");

    ws1.send(awc::ws::Message::Text(
        json!({"type":"join","nickname":"alice"}).to_string().into(),
    ))
    .await
    .expect("join ws1");
    ws2.send(awc::ws::Message::Text(
        json!({"type":"join","nickname":"bob"}).to_string().into(),
    ))
    .await
    .expect("join ws2");

    let _ = read_next_text(&mut ws1).await;
    let _ = read_next_text(&mut ws1).await;
    let _ = read_next_text(&mut ws2).await;
    let _ = read_next_text(&mut ws2).await;

    ws1.send(awc::ws::Message::Text(
        json!({"type":"message","requestId":"msg-1","body":"hello"})
            .to_string()
            .into(),
    ))
    .await
    .expect("message send should succeed");

    let sent_to_ws1 = read_next_text(&mut ws1).await;
    let sent_to_ws2 = read_next_text(&mut ws2).await;
    assert_eq!(sent_to_ws1["type"], "message");
    assert_eq!(sent_to_ws2["type"], "message");
    let message_id = sent_to_ws1["item"]["id"]
        .as_i64()
        .expect("message id should be present");

    ws2.send(awc::ws::Message::Text(
        json!({
            "type":"delete",
            "requestId":"del-1",
            "messageId": message_id
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("delete send should succeed");

    let deleted1 = read_next_text(&mut ws1).await;
    let deleted2 = read_next_text(&mut ws2).await;
    assert_eq!(deleted1["type"], "deleted");
    assert_eq!(deleted2["type"], "deleted");
    assert_eq!(deleted1["messageId"], message_id);
    assert_eq!(deleted2["messageId"], message_id);

    handle.stop(true).await;
}
