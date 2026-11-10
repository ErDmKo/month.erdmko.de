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
async fn ws_upgrade_rejects_missing_invalid_expired_and_revoked_sessions() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx.clone());

    // 1. Missing cookie -> 401 Unauthorized
    let no_cookie_err = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .connect()
        .await
        .err()
        .expect("missing session cookie must fail upgrade");
    assert!(
        matches!(
            no_cookie_err,
            awc::error::WsClientError::InvalidResponseStatus(
                actix_web::http::StatusCode::UNAUTHORIZED
            )
        ),
        "expected 401 UNAUTHORIZED for missing cookie, got {no_cookie_err:?}"
    );

    // 2. Unknown token -> 401 Unauthorized
    let unknown_cookie_err = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", "month_session=unknown_token_123")
        .connect()
        .await
        .err()
        .expect("unknown session token must fail upgrade");
    assert!(
        matches!(
            unknown_cookie_err,
            awc::error::WsClientError::InvalidResponseStatus(
                actix_web::http::StatusCode::UNAUTHORIZED
            )
        ),
        "expected 401 UNAUTHORIZED for unknown token, got {unknown_cookie_err:?}"
    );

    // 3. Expired session token (even for a paid wallet) -> 401 Unauthorized
    let paid_wallet = wallet_for_label("paid_expired_session");
    let _ = issue_test_session_cookie(&ctx, &paid_wallet, true);
    let expired_token = {
        let conn = ctx.pool.get().unwrap();
        let past_now = chrono::Utc::now().timestamp() - 3600;
        let session = crate::auth::db::create_session(&conn, &paid_wallet, past_now, 60).unwrap();
        session.token
    };
    let expired_cookie_err = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", format!("month_session={expired_token}"))
        .connect()
        .await
        .err()
        .expect("expired session token must fail upgrade");
    assert!(
        matches!(
            expired_cookie_err,
            awc::error::WsClientError::InvalidResponseStatus(
                actix_web::http::StatusCode::UNAUTHORIZED
            )
        ),
        "expected 401 UNAUTHORIZED for expired token, got {expired_cookie_err:?}"
    );

    // 4. Revoked session token -> 401 Unauthorized
    let revoked_wallet = wallet_for_label("paid_revoked_session");
    let revoked_cookie = issue_test_session_cookie(&ctx, &revoked_wallet, true);
    let revoked_token = revoked_cookie
        .strip_prefix("month_session=")
        .unwrap()
        .to_string();
    {
        let conn = ctx.pool.get().unwrap();
        assert!(crate::auth::db::revoke_session(&conn, &revoked_token).unwrap());
    }
    let revoked_cookie_err = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", revoked_cookie)
        .connect()
        .await
        .err()
        .expect("revoked session token must fail upgrade");
    assert!(
        matches!(
            revoked_cookie_err,
            awc::error::WsClientError::InvalidResponseStatus(
                actix_web::http::StatusCode::UNAUTHORIZED
            )
        ),
        "expected 401 UNAUTHORIZED for revoked token, got {revoked_cookie_err:?}"
    );

    handle.stop(true).await;
}

#[actix_web::test]
async fn unpaid_wallet_is_rejected_on_upgrade_and_join_with_payment_required() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx.clone());

    let unpaid_wallet = wallet_for_label("unpaid_user");
    let unpaid_cookie = issue_test_session_cookie(&ctx, &unpaid_wallet, false);

    // 1. Unpaid wallet is rejected at HTTP WebSocket upgrade with 403 Forbidden
    let upgrade_err = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", unpaid_cookie)
        .connect()
        .await
        .err()
        .expect("unpaid wallet must be rejected at WS upgrade");
    assert!(
        matches!(
            upgrade_err,
            awc::error::WsClientError::InvalidResponseStatus(
                actix_web::http::StatusCode::FORBIDDEN
            )
        ),
        "expected 403 FORBIDDEN for unpaid wallet upgrade, got {upgrade_err:?}"
    );

    // 2. Wallet with expired paid access at upgrade time is rejected with 403 Forbidden
    let expired_access_wallet = wallet_for_label("expired_access_user");
    let expired_access_cookie = issue_test_session_cookie(&ctx, &expired_access_wallet, true);
    {
        let conn = ctx.pool.get().unwrap();
        let past_ts = chrono::Utc::now().timestamp() - 10;
        conn.execute(
            format!(
                "UPDATE {} SET access_until = ?1 WHERE wallet_address = ?2",
                crate::auth::db::WALLET_PROFILES_TABLE
            )
            .as_str(),
            (past_ts, &expired_access_wallet),
        )
        .unwrap();
    }
    let expired_access_err = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", expired_access_cookie)
        .connect()
        .await
        .err()
        .expect("expired paid access wallet must be rejected at WS upgrade");
    assert!(
        matches!(
            expired_access_err,
            awc::error::WsClientError::InvalidResponseStatus(
                actix_web::http::StatusCode::FORBIDDEN
            )
        ),
        "expected 403 FORBIDDEN for expired paid access upgrade, got {expired_access_err:?}"
    );

    // 3. Wallet whose paid access expires after upgrade but before Join is rejected with PAYMENT_REQUIRED
    let expiring_wallet = wallet_for_label("expiring_before_join_user");
    let expiring_cookie = issue_test_session_cookie(&ctx, &expiring_wallet, true);
    let (_resp, mut ws) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", expiring_cookie)
        .connect()
        .await
        .unwrap();

    {
        let conn = ctx.pool.get().unwrap();
        let past_ts = chrono::Utc::now().timestamp() - 10;
        conn.execute(
            format!(
                "UPDATE {} SET access_until = ?1 WHERE wallet_address = ?2",
                crate::auth::db::WALLET_PROFILES_TABLE
            )
            .as_str(),
            (past_ts, &expiring_wallet),
        )
        .unwrap();
    }

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

#[actix_web::test]
async fn unjoined_and_failed_join_connections_do_not_receive_room_broadcasts() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx.clone());

    // 1. Alice joins the room normally
    let mut ws_alice = ws_join!(addr, room_id, "alice");

    // 2. Bob opens an authenticated, paid WS connection to the same room but does NOT send Join
    let wallet_bob = wallet_for_label("unjoined_bob");
    let cookie_bob = issue_test_session_cookie(&ctx, &wallet_bob, true);
    let (_resp_b, mut ws_bob_unjoined) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie_bob)
        .connect()
        .await
        .unwrap();

    // 3. Charlie opens an authenticated, paid WS connection and sends a Join that fails (NICKNAME_TAKEN)
    let wallet_charlie = wallet_for_label("failed_join_charlie");
    let cookie_charlie = issue_test_session_cookie(&ctx, &wallet_charlie, true);
    let (_resp_c, mut ws_charlie) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room_id))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie_charlie)
        .connect()
        .await
        .unwrap();
    ws_charlie
        .send(awc::ws::Message::Binary(
            encode_join("j-charlie-conflict", "alice").into(),
        ))
        .await
        .unwrap();
    let join_err = unwrap_error(read_next_binary(&mut ws_charlie).await);
    assert_eq!(join_err.code, "NICKNAME_TAKEN");

    // 4. Alice sends a message, uploads an attachment, and deletes the message
    ws_alice
        .send(awc::ws::Message::Binary(
            encode_message("m-secret", "secret paid message").into(),
        ))
        .await
        .unwrap();

    let alice_msg = find_binary(&mut ws_alice, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("Alice receives her own broadcast");
    let msg_id = match alice_msg {
        server_frame::Payload::Message(m) => m.item.unwrap().id,
        _ => unreachable!(),
    };

    let att_bytes = b"confidential attachment";
    ws_alice
        .send(awc::ws::Message::Binary(
            encode_upload_start(
                "up-sec",
                msg_id,
                "secret.txt",
                att_bytes.len() as u32,
                "text/plain",
            )
            .into(),
        ))
        .await
        .unwrap();
    let ready = find_binary(&mut ws_alice, 5, |f| {
        matches!(f, server_frame::Payload::UploadReady(_))
    })
    .await
    .expect("upload_ready");
    let upload_id = match ready {
        server_frame::Payload::UploadReady(r) => r.upload_id,
        _ => unreachable!(),
    };
    ws_alice
        .send(awc::ws::Message::Binary(
            encode_upload_chunk_frame(upload_id, 0, att_bytes).into(),
        ))
        .await
        .unwrap();
    ws_alice
        .send(awc::ws::Message::Binary(
            encode_upload_end("up-sec", upload_id).into(),
        ))
        .await
        .unwrap();
    let _ = find_binary(&mut ws_alice, 5, |f| {
        matches!(f, server_frame::Payload::UploadDone(_))
    })
    .await
    .expect("Alice receives upload_done broadcast");

    ws_alice
        .send(awc::ws::Message::Binary(
            encode_delete("del-sec", msg_id).into(),
        ))
        .await
        .unwrap();
    let _ = find_binary(&mut ws_alice, 5, |f| {
        matches!(f, server_frame::Payload::Deleted(_))
    })
    .await
    .expect("Alice receives deleted broadcast");

    // 5. Neither unjoined Bob nor failed-join Charlie receives any broadcast frame
    let bob_recv =
        actix_web::rt::time::timeout(Duration::from_millis(300), ws_bob_unjoined.next()).await;
    assert!(
        bob_recv.is_err(),
        "unjoined connection must not receive room broadcasts"
    );

    let charlie_recv =
        actix_web::rt::time::timeout(Duration::from_millis(300), ws_charlie.next()).await;
    assert!(
        charlie_recv.is_err(),
        "connection with failed Join must not receive room broadcasts"
    );

    // 6. Once Charlie sends a valid Join with an available nickname, Charlie receives subsequent broadcasts
    ws_charlie
        .send(awc::ws::Message::Binary(
            encode_join("j-charlie-ok", "charlie").into(),
        ))
        .await
        .unwrap();
    let _ = read_next_binary(&mut ws_charlie).await; // joined
    let _ = read_next_binary(&mut ws_charlie).await; // history

    ws_alice
        .send(awc::ws::Message::Binary(
            encode_message("m-after-join", "welcome charlie").into(),
        ))
        .await
        .unwrap();
    let charlie_msg = find_binary(&mut ws_charlie, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("Charlie receives broadcast after successful Join");
    match charlie_msg {
        server_frame::Payload::Message(m) => {
            assert_eq!(m.item.unwrap().body, "welcome charlie");
        }
        _ => unreachable!(),
    }

    handle.stop(true).await;
}

#[actix_web::test]
async fn session_revocation_and_access_expiry_revoke_broadcasts_and_close_socket() {
    let ctx = setup_ctx();
    let room_id = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx.clone());

    let mut ws_alice = ws_join!(addr, room_id, "alice");
    let mut ws_bob = ws_join!(addr, room_id, "bob");
    let mut ws_charlie = ws_join!(addr, room_id, "charlie");

    // 1. Valid ClientPing from Alice succeeds without error
    ws_alice
        .send(awc::ws::Message::Binary(encode_ping("p-ok").into()))
        .await
        .unwrap();

    // 2. Revoke Bob's session in SQLite while Bob's WebSocket is open and joined
    let wallet_bob = wallet_for_label("bob");
    {
        let conn = ctx.pool.get().unwrap();
        conn.execute(
            format!(
                "DELETE FROM {} WHERE wallet_address = ?1",
                crate::auth::db::AUTH_SESSIONS_TABLE
            )
            .as_str(),
            (&wallet_bob,),
        )
        .unwrap();
    }

    // 3. Expire Charlie's paid access in SQLite while Charlie's WebSocket is open and joined
    let wallet_charlie = wallet_for_label("charlie");
    {
        let conn = ctx.pool.get().unwrap();
        let past_ts = chrono::Utc::now().timestamp() - 5;
        conn.execute(
            format!(
                "UPDATE {} SET access_until = ?1 WHERE wallet_address = ?2",
                crate::auth::db::WALLET_PROFILES_TABLE
            )
            .as_str(),
            (past_ts, &wallet_charlie),
        )
        .unwrap();
    }

    // 4. Alice sends a room message -> Bob and Charlie must NOT receive the message;
    // instead they receive UNAUTHORIZED / PAYMENT_REQUIRED and their sockets are closed!
    ws_alice
        .send(awc::ws::Message::Binary(
            encode_message("m-live", "only active members see this").into(),
        ))
        .await
        .unwrap();

    let alice_msg = find_binary(&mut ws_alice, 5, |f| {
        matches!(f, server_frame::Payload::Message(_))
    })
    .await
    .expect("Alice receives her broadcast");
    match alice_msg {
        server_frame::Payload::Message(m) => {
            assert_eq!(m.item.unwrap().body, "only active members see this");
        }
        _ => unreachable!(),
    }

    let bob_err = unwrap_error(read_next_binary(&mut ws_bob).await);
    assert_eq!(bob_err.code, "UNAUTHORIZED");
    let bob_next = actix_web::rt::time::timeout(Duration::from_secs(1), ws_bob.next())
        .await
        .expect("bob close frame should arrive");
    assert!(
        matches!(bob_next, Some(Ok(awc::ws::Frame::Close(_))) | None),
        "expected Bob's socket to be closed by server, got {bob_next:?}"
    );

    let charlie_err = unwrap_error(read_next_binary(&mut ws_charlie).await);
    assert_eq!(charlie_err.code, "PAYMENT_REQUIRED");
    let charlie_next = actix_web::rt::time::timeout(Duration::from_secs(1), ws_charlie.next())
        .await
        .expect("charlie close frame should arrive");
    assert!(
        matches!(charlie_next, Some(Ok(awc::ws::Frame::Close(_))) | None),
        "expected Charlie's socket to be closed by server, got {charlie_next:?}"
    );

    handle.stop(true).await;
}
