use super::helpers::*;
use crate::generated::chat::server_frame;
use rand::random;

#[actix_web::test]
async fn join_sends_joined_and_history() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_id).await.unwrap();
    chat_db::insert_message(&ctx, &room_id, "u1", "alice", "hello history").await.unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let sctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new().app_data(sctx.clone()).service(chat_ws_page_handler)
    })
    .listen(listener).unwrap().run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .connect().await.unwrap();

    ws.send(awc::ws::Message::Binary(encode_join("r1", "dima").into())).await.unwrap();

    let first = read_next_binary(&mut ws).await;
    let second = read_next_binary(&mut ws).await;
    let frames = vec![first, second];

    assert!(frames.iter().any(|f| matches!(f, server_frame::Payload::Joined(_))));

    let history = frames.iter().find_map(|f| {
        if let server_frame::Payload::History(h) = f { Some(h) } else { None }
    }).expect("history frame");
    assert!(history.items.iter().any(|i| i.body == "hello history"));

    handle.stop(true).await;
}

#[actix_web::test]
async fn message_broadcasts_only_inside_room() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let other_room = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx);

    let mut ws1 = ws_join!(addr, room_id, "alice");
    let mut ws2 = ws_join!(addr, room_id, "bob");
    let mut ws_other = ws_join!(addr, other_room, "charlie");

    ws1.send(awc::ws::Message::Binary(encode_message("m1", "hello room").into())).await.unwrap();

    let msg1 = find_binary(&mut ws1, 5, |f| matches!(f, server_frame::Payload::Message(_)))
        .await.expect("ws1 message");
    let msg2 = find_binary(&mut ws2, 5, |f| matches!(f, server_frame::Payload::Message(_)))
        .await.expect("ws2 message");

    let body1 = match msg1 { server_frame::Payload::Message(m) => m.item.unwrap().body, _ => unreachable!() };
    let body2 = match msg2 { server_frame::Payload::Message(m) => m.item.unwrap().body, _ => unreachable!() };
    assert_eq!(body1, "hello room");
    assert_eq!(body2, "hello room");

    let no_msg = actix_web::rt::time::timeout(Duration::from_millis(300), ws_other.next()).await;
    assert!(no_msg.is_err(), "other room should not receive broadcast");

    handle.stop(true).await;
}

#[actix_web::test]
async fn oversized_payload_returns_bad_payload_and_connection_survives() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx);

    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .connect().await.unwrap();

    let oversized = vec![0u8; WS_MAX_PAYLOAD_BYTES + 1];
    ws.send(awc::ws::Message::Binary(oversized.into())).await.unwrap();

    let err = unwrap_error(read_next_binary(&mut ws).await);
    assert_eq!(err.code, "BAD_PAYLOAD");

    // connection should survive — join normally
    ws.send(awc::ws::Message::Binary(encode_join("j2", "dima").into())).await.unwrap();
    let f1 = read_next_binary(&mut ws).await;
    let f2 = read_next_binary(&mut ws).await;
    assert!(
        matches!(f1, server_frame::Payload::Joined(_)) || matches!(f2, server_frame::Payload::Joined(_)),
        "connection should remain alive after bad payload"
    );

    handle.stop(true).await;
}

#[actix_web::test]
async fn rate_limit_returns_rate_limited_error() {
    use crate::chat::service as chat_service;

    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room_id, "alice");

    for i in 0..(chat_service::RATE_LIMIT_MAX_MESSAGES + 1) {
        ws.send(awc::ws::Message::Binary(
            encode_message(&format!("m{i}"), &format!("hello-{i}")).into(),
        )).await.unwrap();
    }

    let mut rate_limited = false;
    for _ in 0..(chat_service::RATE_LIMIT_MAX_MESSAGES + 2) {
        let f = read_next_binary(&mut ws).await;
        if let server_frame::Payload::Error(e) = f {
            if e.code == "RATE_LIMITED" { rate_limited = true; break; }
        }
    }
    assert!(rate_limited, "expected RATE_LIMITED error");

    handle.stop(true).await;
}

#[actix_web::test]
async fn malformed_payload_does_not_break_connection() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx);

    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .connect().await.unwrap();

    // non-empty bytes that won't parse as a valid ClientFrame oneof
    ws.send(awc::ws::Message::Binary(vec![0xFF, 0xFF, 0xFF].into())).await.unwrap();

    let err = unwrap_error(read_next_binary(&mut ws).await);
    assert_eq!(err.code, "BAD_PAYLOAD");

    ws.send(awc::ws::Message::Binary(encode_join("j2", "alice").into())).await.unwrap();
    let f1 = read_next_binary(&mut ws).await;
    let f2 = read_next_binary(&mut ws).await;
    assert!(
        matches!(f1, server_frame::Payload::Joined(_)) || matches!(f2, server_frame::Payload::Joined(_)),
        "socket should remain usable after malformed payload"
    );

    handle.stop(true).await;
}

#[actix_web::test]
async fn delete_broadcasts_deleted_event_to_room_clients() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx);

    let mut ws1 = ws_join!(addr, room_id, "alice");
    let mut ws2 = ws_join!(addr, room_id, "bob");

    ws1.send(awc::ws::Message::Binary(encode_message("m1", "hello").into())).await.unwrap();

    let msg1 = find_binary(&mut ws1, 5, |f| matches!(f, server_frame::Payload::Message(_)))
        .await.expect("ws1 message");
    let _ = find_binary(&mut ws2, 5, |f| matches!(f, server_frame::Payload::Message(_)))
        .await.expect("ws2 message");

    let message_id = match msg1 {
        server_frame::Payload::Message(m) => m.item.unwrap().id,
        _ => unreachable!(),
    };

    ws2.send(awc::ws::Message::Binary(encode_delete("d1", message_id).into())).await.unwrap();

    let del1 = find_binary(&mut ws1, 5, |f| matches!(f, server_frame::Payload::Deleted(_)))
        .await.expect("ws1 deleted");
    let del2 = find_binary(&mut ws2, 5, |f| matches!(f, server_frame::Payload::Deleted(_)))
        .await.expect("ws2 deleted");

    let id1 = match del1 { server_frame::Payload::Deleted(d) => d.message_id, _ => unreachable!() };
    let id2 = match del2 { server_frame::Payload::Deleted(d) => d.message_id, _ => unreachable!() };
    assert_eq!(id1, message_id);
    assert_eq!(id2, message_id);

    handle.stop(true).await;
}
