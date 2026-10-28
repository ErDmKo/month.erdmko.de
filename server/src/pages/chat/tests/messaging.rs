use super::helpers::*;
use crate::generated::chat::server_frame;
use rand::random;

#[actix_web::test]
async fn join_sends_joined_and_history() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_id)
        .await
        .unwrap();
    chat_db::insert_message(&ctx, &room_id, "u1", "alice", "hello history")
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    register_test_ctx(addr, ctx.clone());
    let sctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(sctx.clone())
            .service(chat_ws_page_handler)
    })
    // See spawn_server! macro comment in helpers.rs — avoids actix-web's
    // default 30s graceful-shutdown wait for the still-open WS connection.
    .shutdown_timeout(0)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let cookie = issue_paid_cookie_for_addr(addr, "dima");
    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie)
        .connect()
        .await
        .unwrap();

    ws.send(awc::ws::Message::Binary(encode_join("r1", "dima").into()))
        .await
        .unwrap();

    let first = read_next_binary(&mut ws).await;
    let second = read_next_binary(&mut ws).await;
    let frames = vec![first, second];

    assert!(
        frames
            .iter()
            .any(|f| matches!(f, server_frame::Payload::Joined(_)))
    );

    let history = frames
        .iter()
        .find_map(|f| {
            if let server_frame::Payload::History(h) = f {
                Some(h)
            } else {
                None
            }
        })
        .expect("history frame");
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

    ws1.send(awc::ws::Message::Binary(
        encode_message("m1", "hello room").into(),
    ))
    .await
    .unwrap();

    let msg1 = find_binary(&mut ws1, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("ws1 message");
    let msg2 = find_binary(&mut ws2, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("ws2 message");

    let body1 = match msg1 {
        server_frame::Payload::Message(m) => m.item.unwrap().body,
        _ => unreachable!(),
    };
    let body2 = match msg2 {
        server_frame::Payload::Message(m) => m.item.unwrap().body,
        _ => unreachable!(),
    };
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

    let cookie = issue_paid_cookie_for_addr(addr, "dima");
    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie)
        .connect()
        .await
        .unwrap();

    let oversized = vec![0u8; WS_MAX_PAYLOAD_BYTES + 1];
    ws.send(awc::ws::Message::Binary(oversized.into()))
        .await
        .unwrap();

    let err = unwrap_error(read_next_binary(&mut ws).await);
    assert_eq!(err.code, "BAD_PAYLOAD");

    // connection should survive — join normally
    ws.send(awc::ws::Message::Binary(encode_join("j2", "dima").into()))
        .await
        .unwrap();
    let f1 = read_next_binary(&mut ws).await;
    let f2 = read_next_binary(&mut ws).await;
    assert!(
        matches!(f1, server_frame::Payload::Joined(_))
            || matches!(f2, server_frame::Payload::Joined(_)),
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
        ))
        .await
        .unwrap();
    }

    let mut rate_limited = false;
    for _ in 0..(chat_service::RATE_LIMIT_MAX_MESSAGES + 2) {
        let f = read_next_binary(&mut ws).await;
        if let server_frame::Payload::Error(e) = f {
            if e.code == "RATE_LIMITED" {
                rate_limited = true;
                break;
            }
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

    let cookie = issue_paid_cookie_for_addr(addr, "alice");
    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie)
        .connect()
        .await
        .unwrap();

    // non-empty bytes that won't parse as a valid ClientFrame oneof
    ws.send(awc::ws::Message::Binary(vec![0xFF, 0xFF, 0xFF].into()))
        .await
        .unwrap();

    let err = unwrap_error(read_next_binary(&mut ws).await);
    assert_eq!(err.code, "BAD_PAYLOAD");

    ws.send(awc::ws::Message::Binary(encode_join("j2", "alice").into()))
        .await
        .unwrap();
    let f1 = read_next_binary(&mut ws).await;
    let f2 = read_next_binary(&mut ws).await;
    assert!(
        matches!(f1, server_frame::Payload::Joined(_))
            || matches!(f2, server_frame::Payload::Joined(_)),
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

    ws1.send(awc::ws::Message::Binary(
        encode_message("m1", "hello").into(),
    ))
    .await
    .unwrap();

    let msg1 = find_binary(&mut ws1, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("ws1 message");
    let _ = find_binary(&mut ws2, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("ws2 message");

    let message_id = match msg1 {
        server_frame::Payload::Message(m) => m.item.unwrap().id,
        _ => unreachable!(),
    };

    ws1.send(awc::ws::Message::Binary(
        encode_delete("d1", message_id).into(),
    ))
    .await
    .unwrap();

    let del1 = find_binary(&mut ws1, 5, |f| {
        matches!(f, server_frame::Payload::Deleted(_))
    })
    .await
    .expect("ws1 deleted");
    let del2 = find_binary(&mut ws2, 5, |f| {
        matches!(f, server_frame::Payload::Deleted(_))
    })
    .await
    .expect("ws2 deleted");

    let id1 = match del1 {
        server_frame::Payload::Deleted(d) => d.message_id,
        _ => unreachable!(),
    };
    let id2 = match del2 {
        server_frame::Payload::Deleted(d) => d.message_id,
        _ => unreachable!(),
    };
    assert_eq!(id1, message_id);
    assert_eq!(id2, message_id);

    handle.stop(true).await;
}

#[actix_web::test]
async fn reconnecting_with_same_session_cookie_preserves_wallet_sender_id_and_nickname() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx.clone());

    let wallet_a = wallet_for_label("wallet_alice");
    let cookie_a = issue_test_session_cookie(&ctx, &wallet_a, true);

    // First connection: join with "alice_eth"
    let (_resp1, mut ws1) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie_a.clone())
        .connect()
        .await
        .unwrap();
    ws1.send(awc::ws::Message::Binary(
        encode_join("j1", "alice_eth").into(),
    ))
    .await
    .unwrap();

    let joined1 = match read_next_binary(&mut ws1).await {
        server_frame::Payload::Joined(j) => j,
        other => panic!("expected Joined frame, got {other:?}"),
    };
    assert_eq!(joined1.sender_id, wallet_a);
    assert_eq!(joined1.sender_name, "alice_eth");
    let _ = read_next_binary(&mut ws1).await; // history
    drop(ws1);

    // Reconnect with the same session cookie and empty nickname: preserves wallet sender_id and saved nickname
    let (_resp2, mut ws2) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie_a)
        .connect()
        .await
        .unwrap();
    ws2.send(awc::ws::Message::Binary(encode_join("j2", "").into()))
        .await
        .unwrap();

    let joined2 = match read_next_binary(&mut ws2).await {
        server_frame::Payload::Joined(j) => j,
        other => panic!("expected Joined frame on reconnect, got {other:?}"),
    };
    assert_eq!(joined2.sender_id, wallet_a);
    assert_eq!(joined2.sender_name, "alice_eth");

    handle.stop(true).await;
}

#[actix_web::test]
async fn unpaid_wallet_is_rejected_on_join_with_payment_required() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx.clone());

    let unpaid_wallet = wallet_for_label("unpaid_user");
    let unpaid_cookie = issue_test_session_cookie(&ctx, &unpaid_wallet, false);

    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", unpaid_cookie)
        .connect()
        .await
        .unwrap();

    ws.send(awc::ws::Message::Binary(
        encode_join("j-unpaid", "unpaid_nick").into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(read_next_binary(&mut ws).await);
    assert_eq!(err.code, "PAYMENT_REQUIRED");

    handle.stop(true).await;
}

#[actix_web::test]
async fn second_wallet_claiming_taken_nickname_receives_nickname_taken() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx.clone());

    let _ws_alice = ws_join!(addr, room_id, "shared_nick");

    let wallet_bob = wallet_for_label("distinct_bob_wallet");
    let cookie_bob = issue_test_session_cookie(&ctx, &wallet_bob, true);
    let (_resp, mut ws_bob) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie_bob)
        .connect()
        .await
        .unwrap();

    ws_bob
        .send(awc::ws::Message::Binary(
            encode_join("j-bob", "shared_nick").into(),
        ))
        .await
        .unwrap();

    let err = unwrap_error(read_next_binary(&mut ws_bob).await);
    assert_eq!(err.code, "NICKNAME_TAKEN");

    handle.stop(true).await;
}

#[actix_web::test]
async fn wallet_a_cannot_delete_wallet_b_message() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx);

    let mut ws_a = ws_join!(addr, room_id, "alice");
    let mut ws_b = ws_join!(addr, room_id, "bob");

    // Wallet B sends a message
    ws_b.send(awc::ws::Message::Binary(
        encode_message("m-b", "bob message").into(),
    ))
    .await
    .unwrap();

    let msg_a = find_binary(&mut ws_a, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("ws_a receives bob's message");
    let _ = find_binary(&mut ws_b, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("ws_b receives own message");

    let bob_message_id = match msg_a {
        server_frame::Payload::Message(m) => m.item.unwrap().id,
        _ => unreachable!(),
    };

    // Wallet A attempts to delete Wallet B's message -> receives VALIDATION_ERROR
    ws_a.send(awc::ws::Message::Binary(
        encode_delete("del-unauth", bob_message_id).into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(read_next_binary(&mut ws_a).await);
    assert_eq!(err.code, "VALIDATION_ERROR");

    handle.stop(true).await;
}
