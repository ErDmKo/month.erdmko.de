use super::helpers::*;
use crate::generated::chat::server_frame;
use rand::random;

fn ensure_voice_init() {
    crate::voice::init();
    let cfg = crate::voice::VoiceConfig {
        public_ip: "127.0.0.1".to_string(),
        rtp_port_min: 50000,
        rtp_port_max: 50100,
    };
    crate::voice::init_rtc(&cfg);
}

#[actix_web::test]
async fn voice_join_and_leave_broadcasts_state() {
    ensure_voice_init();
    let ctx = setup_ctx();
    let room_id = format!("voice-test-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_id)
        .await
        .unwrap();

    let (addr, handle) = spawn_server!(ctx);
    let mut ws1 = ws_join!(addr, room_id, "Alice");
    let mut ws2 = ws_join!(addr, room_id, "Bob");

    // Alice joins voice
    ws1.send(awc::ws::Message::Binary(encode_voice_join("v1").into()))
        .await
        .unwrap();

    let v_state1 = find_binary(&mut ws1, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Alice should receive VoiceState on join");

    if let server_frame::Payload::VoiceState(state) = v_state1 {
        assert_eq!(state.participants.len(), 1);
        assert_eq!(state.participants[0].sender_name, "Alice");
    }

    // Bob also receives Alice's join
    let v_state2 = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Bob should receive VoiceState when Alice joins");

    if let server_frame::Payload::VoiceState(state) = v_state2 {
        assert_eq!(state.participants.len(), 1);
        assert_eq!(state.participants[0].sender_name, "Alice");
    }

    // Alice leaves voice
    ws1.send(awc::ws::Message::Binary(encode_voice_leave("v2").into()))
        .await
        .unwrap();

    let v_leave_state = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Bob should receive updated VoiceState when Alice leaves");

    if let server_frame::Payload::VoiceState(state) = v_leave_state {
        assert_eq!(state.participants.len(), 0);
    }

    handle.stop(true).await;
}

#[actix_web::test]
async fn voice_disconnect_triggers_leave_and_serves_healthz() {
    ensure_voice_init();
    let ctx = setup_ctx();
    let room_id = format!("voice-disc-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_id)
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let sctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(sctx.clone())
            .route(
                "/healthz",
                actix_web::web::get().to(actix_web::HttpResponse::Ok),
            )
            .service(chat_ws_page_handler)
    })
    .shutdown_timeout(0)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let mut ws1 = ws_join!(addr, room_id, "Alice");
    let mut ws2 = ws_join!(addr, room_id, "Bob");

    // Alice joins voice
    ws1.send(awc::ws::Message::Binary(encode_voice_join("v1").into()))
        .await
        .unwrap();

    let _ = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Bob should receive VoiceState");

    // Drop Alice's socket abruptly (simulates browser closing tab)
    drop(ws1);

    // Verify Bob sees Alice leave
    let v_state = find_binary(&mut ws2, 5, |p| {
        if let server_frame::Payload::VoiceState(s) = p {
            s.participants.is_empty()
        } else {
            false
        }
    })
    .await
    .expect("Bob should receive empty VoiceState after Alice disconnects");

    if let server_frame::Payload::VoiceState(state) = v_state {
        assert!(state.participants.is_empty());
    }

    // Healthcheck must respond immediately
    let client = awc::Client::default();
    let res = client
        .get(format!("http://{}/healthz", addr))
        .timeout(Duration::from_millis(500))
        .send()
        .await
        .expect("healthz request should not timeout during/after voice leave");
    assert_eq!(res.status(), actix_web::http::StatusCode::OK);

    handle.stop(true).await;
}

#[actix_web::test]
async fn voice_room_full_rejects_and_rolls_back() {
    ensure_voice_init();
    let ctx = setup_ctx();
    let room_id = format!("voice-full-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_id)
        .await
        .unwrap();

    let (addr, handle) = spawn_server!(ctx);
    let mut sockets = Vec::new();

    // Join 8 participants (the maximum per room)
    for i in 0..8 {
        let nick = format!("User{}", i);
        let mut ws = ws_join!(addr, room_id, &nick);
        ws.send(awc::ws::Message::Binary(encode_voice_join("v-join").into()))
            .await
            .unwrap();
        let _ = find_binary(&mut ws, 5, |p| {
            matches!(p, server_frame::Payload::VoiceState(_))
        })
        .await
        .expect("Participant should join voice");
        sockets.push(ws);
    }

    // 9th participant attempts to join voice
    let mut ws9 = ws_join!(addr, room_id, "User9");
    ws9.send(awc::ws::Message::Binary(
        encode_voice_join("v-join-9").into(),
    ))
    .await
    .unwrap();

    let err = find_binary(&mut ws9, 5, |p| {
        matches!(p, server_frame::Payload::VoiceError(_))
    })
    .await
    .expect("9th participant should receive VoiceError");

    if let server_frame::Payload::VoiceError(e) = err {
        assert_eq!(e.code, "VOICE_ROOM_FULL");
        assert_eq!(e.request_id, "v-join-9");
    }

    handle.stop(true).await;
}

#[actix_web::test]
async fn voice_lifecycle_does_not_block_chat_messaging() {
    ensure_voice_init();
    let ctx = setup_ctx();
    let room_id = format!("voice-msg-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_id)
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let sctx = ctx.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(sctx.clone())
            .route(
                "/healthz",
                actix_web::web::get().to(actix_web::HttpResponse::Ok),
            )
            .service(chat_ws_page_handler)
    })
    .shutdown_timeout(0)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let mut ws1 = ws_join!(addr, room_id, "Alice");
    let mut ws2 = ws_join!(addr, room_id, "Bob");

    // 1. Exchange normal chat message before voice
    ws1.send(awc::ws::Message::Binary(
        encode_message("m1", "hello bob").into(),
    ))
    .await
    .unwrap();

    let msg1 = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await
    .expect("Bob should receive Alice's chat message");
    if let server_frame::Payload::Message(m) = msg1 {
        assert_eq!(m.item.as_ref().unwrap().body, "hello bob");
    }
    // Also drain Alice's own echo of message 1
    let _ = find_binary(&mut ws1, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await;

    // 2. Alice joins voice
    ws1.send(awc::ws::Message::Binary(encode_voice_join("v1").into()))
        .await
        .unwrap();
    let _ = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Bob receives Alice voice state");

    // 3. Bob sends a message WHILE Alice is in voice
    ws2.send(awc::ws::Message::Binary(
        encode_message("m2", "alice you are in voice").into(),
    ))
    .await
    .unwrap();

    let msg2 = find_binary(&mut ws1, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await
    .expect("Alice should receive Bob's message while in voice");
    if let server_frame::Payload::Message(m) = msg2 {
        assert_eq!(m.item.as_ref().unwrap().body, "alice you are in voice");
    }

    // 4. Alice leaves voice
    ws1.send(awc::ws::Message::Binary(encode_voice_leave("v2").into()))
        .await
        .unwrap();
    let _ = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Bob receives voice leave state");

    // 5. Messages continue flowing seamlessly after voice leave
    ws1.send(awc::ws::Message::Binary(
        encode_message("m3", "left voice, chat working").into(),
    ))
    .await
    .unwrap();

    let msg3 = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await
    .expect("Bob should receive Alice's message after voice leave");
    if let server_frame::Payload::Message(m) = msg3 {
        assert_eq!(m.item.as_ref().unwrap().body, "left voice, chat working");
    }

    // 6. Abrupt disconnect of Alice
    drop(ws1);

    // 7. Bob can still send messages and gets history/persistence without stall
    ws2.send(awc::ws::Message::Binary(
        encode_message("m4", "bob is still chatting").into(),
    ))
    .await
    .unwrap();

    let msg4 = find_binary(&mut ws2, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await
    .expect("Bob should receive own message echo");
    if let server_frame::Payload::Message(m) = msg4 {
        assert_eq!(m.item.as_ref().unwrap().body, "bob is still chatting");
    }

    // 8. Health check remains responsive throughout
    let client = awc::Client::default();
    let res = client
        .get(format!("http://{}/healthz", addr))
        .timeout(Duration::from_millis(500))
        .send()
        .await
        .expect("healthz should be responsive");
    assert_eq!(res.status(), actix_web::http::StatusCode::OK);

    handle.stop(true).await;
}
