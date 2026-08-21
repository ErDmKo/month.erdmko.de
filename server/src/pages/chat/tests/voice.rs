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
async fn multi_tab_voice_join_leave_and_chat_messaging() {
    ensure_voice_init();
    let ctx = setup_ctx();
    let room_id = format!("voice-multi-tab-{}", random::<u64>());
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

    let mut tab1 = ws_join!(addr, room_id, "UserTab1");
    let mut tab2 = ws_join!(addr, room_id, "UserTab2");

    // Tab 1 joins voice
    tab1.send(awc::ws::Message::Binary(encode_voice_join("v1").into()))
        .await
        .unwrap();
    let _ = find_binary(&mut tab1, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Tab1 receives voice state");

    // Tab 2 joins voice
    tab2.send(awc::ws::Message::Binary(encode_voice_join("v2").into()))
        .await
        .unwrap();
    let _ = find_binary(&mut tab2, 5, |p| {
        matches!(p, server_frame::Payload::VoiceState(_))
    })
    .await
    .expect("Tab2 receives voice state");

    // Tab 2 leaves voice
    tab2.send(awc::ws::Message::Binary(encode_voice_leave("v3").into()))
        .await
        .unwrap();
    let _ = find_binary(&mut tab1, 5, |p| {
        if let server_frame::Payload::VoiceState(s) = p {
            s.participants.len() == 1
        } else {
            false
        }
    })
    .await
    .expect("Tab1 sees Tab2 leave voice");

    // Tab 1 sends chat message
    tab1.send(awc::ws::Message::Binary(
        encode_message("m1", "tab1 talking").into(),
    ))
    .await
    .unwrap();

    let msg1 = find_binary(&mut tab2, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await
    .expect("Tab2 receives Tab1 message after Tab2 left voice");
    if let server_frame::Payload::Message(m) = msg1 {
        assert_eq!(m.item.as_ref().unwrap().body, "tab1 talking");
    }

    // Tab 2 sends chat message
    tab2.send(awc::ws::Message::Binary(
        encode_message("m2", "tab2 replies").into(),
    ))
    .await
    .unwrap();

    // Drain tab1 message echo first
    let _ = find_binary(&mut tab1, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await;

    let msg2 = find_binary(&mut tab1, 5, |p| {
        matches!(p, server_frame::Payload::Message(_))
    })
    .await
    .expect("Tab1 receives Tab2 message");
    if let server_frame::Payload::Message(m) = msg2 {
        assert_eq!(m.item.as_ref().unwrap().body, "tab2 replies");
    }

    handle.stop(true).await;
}
