use super::helpers::*;
use crate::generated::chat::server_frame;
use rand::random;

#[actix_web::test]
async fn upload_happy_path() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    let file_data = b"hello upload world";
    ws.send(awc::ws::Message::Binary(
        encode_upload_start(
            "up-1",
            msg.id,
            "test.txt",
            file_data.len() as u32,
            "text/plain",
        )
        .into(),
    ))
    .await
    .unwrap();

    let ready = find_binary(&mut ws, 5, |f| {
        matches!(f, server_frame::Payload::UploadReady(_))
    })
    .await
    .expect("upload_ready");
    let upload_id = match ready {
        server_frame::Payload::UploadReady(r) => r.upload_id,
        _ => unreachable!(),
    };

    ws.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 0, file_data).into(),
    ))
    .await
    .unwrap();
    ws.send(awc::ws::Message::Binary(
        encode_upload_end("up-1", upload_id).into(),
    ))
    .await
    .unwrap();

    let done = find_binary(&mut ws, 5, |f| {
        matches!(f, server_frame::Payload::UploadDone(_))
    })
    .await
    .expect("upload_done");
    let d = match done {
        server_frame::Payload::UploadDone(d) => d,
        _ => unreachable!(),
    };
    assert_eq!(d.filename, "test.txt");
    assert!(d.attachment_id > 0);

    handle.stop(true).await;
}

#[actix_web::test]
async fn download_happy_path() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();

    let file_data: Vec<u8> = (0u8..=255).cycle().take(200).collect();
    let attachment_id = {
        let conn = ctx.pool.get().unwrap();
        crate::attachments::db::insert_attachment(
            &conn,
            msg.id,
            "blob.bin",
            file_data.len() as i64,
            "application/octet-stream",
            &file_data,
        )
        .unwrap()
        .meta
        .id
    };

    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Binary(
        encode_download_request("dl-1", attachment_id).into(),
    ))
    .await
    .unwrap();

    let start = find_binary(&mut ws, 5, |f| {
        matches!(f, server_frame::Payload::DownloadStart(_))
    })
    .await
    .expect("download_start");
    let total_chunks = match start {
        server_frame::Payload::DownloadStart(s) => s.total_chunks as usize,
        _ => unreachable!(),
    };

    let mut received: Vec<u8> = Vec::new();
    for _ in 0..total_chunks {
        let chunk = find_binary(&mut ws, 5, |f| {
            matches!(f, server_frame::Payload::DownloadChunk(_))
        })
        .await
        .expect("download_chunk");
        match chunk {
            server_frame::Payload::DownloadChunk(c) => received.extend(c.data),
            _ => unreachable!(),
        }
    }

    let end = find_binary(&mut ws, 5, |f| {
        matches!(f, server_frame::Payload::DownloadEnd(_))
    })
    .await
    .expect("download_end");
    let e = match end {
        server_frame::Payload::DownloadEnd(e) => e,
        _ => unreachable!(),
    };
    assert_eq!(e.attachment_id, attachment_id);
    assert_eq!(received, file_data);

    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_out_of_order_chunk() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Binary(
        encode_upload_start("up-oo", msg.id, "f.bin", 10, "application/octet-stream").into(),
    ))
    .await
    .unwrap();
    let ready = find_binary(&mut ws, 5, |f| {
        matches!(f, server_frame::Payload::UploadReady(_))
    })
    .await
    .expect("upload_ready");
    let upload_id = match ready {
        server_frame::Payload::UploadReady(r) => r.upload_id,
        _ => unreachable!(),
    };

    ws.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 1, &[0u8; 5]).into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(
        find_binary(&mut ws, 5, |f| matches!(f, server_frame::Payload::Error(_)))
            .await
            .expect("error"),
    );
    assert_eq!(err.code, "UPLOAD_CHUNK_OUT_OF_ORDER");

    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_early_end() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Binary(
        encode_upload_start("up-early", msg.id, "f.bin", 10, "application/octet-stream").into(),
    ))
    .await
    .unwrap();
    let ready = find_binary(&mut ws, 5, |f| {
        matches!(f, server_frame::Payload::UploadReady(_))
    })
    .await
    .expect("upload_ready");
    let upload_id = match ready {
        server_frame::Payload::UploadReady(r) => r.upload_id,
        _ => unreachable!(),
    };

    ws.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 0, &[1u8; 5]).into(),
    ))
    .await
    .unwrap();
    ws.send(awc::ws::Message::Binary(
        encode_upload_end("up-early", upload_id).into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(
        find_binary(&mut ws, 5, |f| matches!(f, server_frame::Payload::Error(_)))
            .await
            .expect("error"),
    );
    assert_eq!(err.code, "UPLOAD_INCOMPLETE");

    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_unknown_id() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(9999, 0, b"data").into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(
        find_binary(&mut ws, 5, |f| matches!(f, server_frame::Payload::Error(_)))
            .await
            .expect("error"),
    );
    assert_eq!(err.code, "UPLOAD_NOT_FOUND");

    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_session_limit() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    for i in 0..crate::attachments::MAX_PENDING_UPLOADS_PER_SESSION {
        ws.send(awc::ws::Message::Binary(
            encode_upload_start(
                &format!("up-{i}"),
                msg.id,
                "f.bin",
                5,
                "application/octet-stream",
            )
            .into(),
        ))
        .await
        .unwrap();
        let r = find_binary(&mut ws, 5, |f| {
            matches!(f, server_frame::Payload::UploadReady(_))
        })
        .await
        .expect("upload_ready");
        assert!(matches!(r, server_frame::Payload::UploadReady(_)));
    }

    ws.send(awc::ws::Message::Binary(
        encode_upload_start("up-limit", msg.id, "f.bin", 5, "application/octet-stream").into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(
        find_binary(&mut ws, 5, |f| matches!(f, server_frame::Payload::Error(_)))
            .await
            .expect("error"),
    );
    assert_eq!(err.code, "UPLOAD_LIMIT_EXCEEDED");

    handle.stop(true).await;
}

#[actix_web::test]
async fn download_wrong_room() {
    let ctx = setup_ctx();
    let room_a = format!("room-a-{}", random::<u64>());
    let room_b = format!("room-b-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_a)
        .await
        .unwrap();
    chat_db::create_room_if_not_exists(&ctx, &room_b)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room_a, "u1", "alice", "hi")
        .await
        .unwrap();

    let attachment_id = {
        let conn = ctx.pool.get().unwrap();
        crate::attachments::db::insert_attachment(
            &conn,
            msg.id,
            "secret.txt",
            6,
            "text/plain",
            b"secret",
        )
        .unwrap()
        .meta
        .id
    };

    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room_b, "bob");

    ws.send(awc::ws::Message::Binary(
        encode_download_request("dl-scope", attachment_id).into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(
        find_binary(&mut ws, 5, |f| matches!(f, server_frame::Payload::Error(_)))
            .await
            .expect("error"),
    );
    assert_eq!(err.code, "ATTACHMENT_NOT_FOUND");

    handle.stop(true).await;
}

#[actix_web::test]
async fn disconnect_cancels_upload() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx.clone());

    {
        let mut ws = ws_join!(addr, room, "alice");
        ws.send(awc::ws::Message::Binary(
            encode_upload_start("up-dc", msg.id, "f.bin", 10, "application/octet-stream").into(),
        ))
        .await
        .unwrap();
        let r = find_binary(&mut ws, 5, |f| {
            matches!(f, server_frame::Payload::UploadReady(_))
        })
        .await
        .expect("upload_ready");
        assert!(matches!(r, server_frame::Payload::UploadReady(_)));
        // drop ws without upload_end
    }

    actix_web::rt::time::sleep(Duration::from_millis(200)).await;
    let conn = ctx.pool.get().unwrap();
    let count: i64 = conn
        .query_row(
            format!(
                "SELECT COUNT(*) FROM {}",
                crate::attachments::db::ATTACHMENTS_TABLE
            )
            .as_str(),
            (),
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0, "incomplete upload must not be persisted");

    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_done_broadcast() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws1 = ws_join!(addr, room, "alice");
    let mut ws2 = ws_join!(addr, room, "bob");

    let file_data = b"broadcast test";
    ws1.send(awc::ws::Message::Binary(
        encode_upload_start(
            "up-bc",
            msg.id,
            "bc.txt",
            file_data.len() as u32,
            "text/plain",
        )
        .into(),
    ))
    .await
    .unwrap();
    let ready = find_binary(&mut ws1, 5, |f| {
        matches!(f, server_frame::Payload::UploadReady(_))
    })
    .await
    .expect("upload_ready");
    let upload_id = match ready {
        server_frame::Payload::UploadReady(r) => r.upload_id,
        _ => unreachable!(),
    };

    ws1.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 0, file_data).into(),
    ))
    .await
    .unwrap();
    ws1.send(awc::ws::Message::Binary(
        encode_upload_end("up-bc", upload_id).into(),
    ))
    .await
    .unwrap();

    let done1 = find_binary(&mut ws1, 5, |f| {
        matches!(f, server_frame::Payload::UploadDone(_))
    })
    .await
    .expect("ws1 done");
    let done2 = find_binary(&mut ws2, 5, |f| {
        matches!(f, server_frame::Payload::UploadDone(_))
    })
    .await
    .expect("ws2 done");
    let (name1, id1) = match done1 {
        server_frame::Payload::UploadDone(d) => (d.filename, d.attachment_id),
        _ => unreachable!(),
    };
    let (name2, id2) = match done2 {
        server_frame::Payload::UploadDone(d) => (d.filename, d.attachment_id),
        _ => unreachable!(),
    };
    assert_eq!(name1, "bc.txt");
    assert_eq!(name2, "bc.txt");
    assert_eq!(id1, id2);

    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_start_rejects_oversized_size() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, &wallet_for_label("alice"), "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Binary(
        encode_upload_start(
            "up-big",
            msg.id,
            "big.bin",
            (crate::attachments::MAX_ATTACHMENT_SIZE_BYTES + 1) as u32,
            "application/octet-stream",
        )
        .into(),
    ))
    .await
    .unwrap();

    let err = unwrap_error(
        find_binary(&mut ws, 5, |f| matches!(f, server_frame::Payload::Error(_)))
            .await
            .expect("error"),
    );
    assert_eq!(err.code, "UPLOAD_TOO_LARGE");

    handle.stop(true).await;
}

#[actix_web::test]
async fn unjoined_client_cannot_download_or_upload_attachments() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let wallet_alice = wallet_for_label("alice");
    let msg = chat_db::insert_message(&ctx, &room, &wallet_alice, "alice", "hi")
        .await
        .unwrap();
    let attachment_id = {
        let conn = ctx.pool.get().unwrap();
        crate::attachments::db::insert_attachment(
            &conn,
            msg.id,
            "secret.txt",
            6,
            "text/plain",
            b"secret",
        )
        .unwrap()
        .meta
        .id
    };

    let (addr, handle) = spawn_server!(ctx.clone());
    let cookie = issue_test_session_cookie(&ctx, &wallet_alice, true);
    let (_resp, mut ws_unjoined) = awc::Client::new()
        .ws(format!("ws://{}/ws/chat/{}", addr, room))
        .set_header("Origin", "http://localhost:8080")
        .set_header("Cookie", cookie)
        .connect()
        .await
        .unwrap();

    // 1. Unjoined client requests download -> VALIDATION_ERROR
    ws_unjoined
        .send(awc::ws::Message::Binary(
            encode_download_request("dl-unjoined", attachment_id).into(),
        ))
        .await
        .unwrap();
    let dl_err = unwrap_error(read_next_binary(&mut ws_unjoined).await);
    assert_eq!(dl_err.code, "VALIDATION_ERROR");

    // 2. Unjoined client requests upload_start -> VALIDATION_ERROR
    ws_unjoined
        .send(awc::ws::Message::Binary(
            encode_upload_start("up-unjoined", msg.id, "f.txt", 4, "text/plain").into(),
        ))
        .await
        .unwrap();
    let up_err = unwrap_error(read_next_binary(&mut ws_unjoined).await);
    assert_eq!(up_err.code, "VALIDATION_ERROR");

    // 3. Unjoined client sends upload_chunk -> VALIDATION_ERROR
    ws_unjoined
        .send(awc::ws::Message::Binary(
            encode_upload_chunk_frame(1, 0, b"test").into(),
        ))
        .await
        .unwrap();
    let chunk_err = unwrap_error(read_next_binary(&mut ws_unjoined).await);
    assert_eq!(chunk_err.code, "VALIDATION_ERROR");

    // 4. Unjoined client sends upload_end -> VALIDATION_ERROR
    ws_unjoined
        .send(awc::ws::Message::Binary(
            encode_upload_end("up-unjoined", 1).into(),
        ))
        .await
        .unwrap();
    let end_err = unwrap_error(read_next_binary(&mut ws_unjoined).await);
    assert_eq!(end_err.code, "VALIDATION_ERROR");

    handle.stop(true).await;
}

#[actix_web::test]
async fn wallet_cannot_upload_attachment_to_another_wallets_message_or_wrong_room() {
    let ctx = setup_ctx();
    let room_a = format!("room-a-{}", random::<u64>());
    let room_b = format!("room-b-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room_a)
        .await
        .unwrap();
    chat_db::create_room_if_not_exists(&ctx, &room_b)
        .await
        .unwrap();

    let alice_msg =
        chat_db::insert_message(&ctx, &room_a, &wallet_for_label("alice"), "alice", "hi")
            .await
            .unwrap();
    let bob_other_room_msg =
        chat_db::insert_message(&ctx, &room_b, &wallet_for_label("bob"), "bob", "hi in b")
            .await
            .unwrap();

    let (addr, handle) = spawn_server!(ctx);
    let mut ws_bob = ws_join!(addr, room_a, "bob");

    // 1. Bob tries to attach a file to Alice's message in room_a -> VALIDATION_ERROR
    ws_bob
        .send(awc::ws::Message::Binary(
            encode_upload_start("up-steal", alice_msg.id, "evil.txt", 4, "text/plain").into(),
        ))
        .await
        .unwrap();
    let err1 = unwrap_error(read_next_binary(&mut ws_bob).await);
    assert_eq!(err1.code, "VALIDATION_ERROR");

    // 2. Bob tries to attach a file to his own message from room_b while in room_a -> VALIDATION_ERROR
    ws_bob
        .send(awc::ws::Message::Binary(
            encode_upload_start(
                "up-wrong-room",
                bob_other_room_msg.id,
                "cross.txt",
                4,
                "text/plain",
            )
            .into(),
        ))
        .await
        .unwrap();
    let err2 = unwrap_error(read_next_binary(&mut ws_bob).await);
    assert_eq!(err2.code, "VALIDATION_ERROR");

    handle.stop(true).await;
}

#[actix_web::test]
async fn direct_requests_fail_when_session_token_revoked_or_paid_access_expired() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let wallet_alice = wallet_for_label("alice");
    let msg = chat_db::insert_message(&ctx, &room, &wallet_alice, "alice", "hi")
        .await
        .unwrap();
    let attachment_id = {
        let conn = ctx.pool.get().unwrap();
        crate::attachments::db::insert_attachment(
            &conn,
            msg.id,
            "secret.txt",
            6,
            "text/plain",
            b"secret",
        )
        .unwrap()
        .meta
        .id
    };

    let (addr, handle) = spawn_server!(ctx.clone());
    let mut ws_alice = ws_join!(addr, room, "alice");
    let mut ws_bob = ws_join!(addr, room, "bob");

    // 1. Expire Alice's paid access while socket is open and joined -> DownloadRequest fails with PAYMENT_REQUIRED and closes socket
    {
        let conn = ctx.pool.get().unwrap();
        let past_ts = chrono::Utc::now().timestamp() - 10;
        conn.execute(
            format!(
                "UPDATE {} SET access_until = ?1 WHERE wallet_address = ?2",
                crate::auth::db::WALLET_PROFILES_TABLE
            )
            .as_str(),
            (past_ts, &wallet_alice),
        )
        .unwrap();
    }

    ws_alice
        .send(awc::ws::Message::Binary(
            encode_download_request("dl-exp", attachment_id).into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        unwrap_error(read_next_binary(&mut ws_alice).await).code,
        "PAYMENT_REQUIRED"
    );

    // 2. Revoke Bob's session token while socket is open and joined -> DownloadRequest fails with UNAUTHORIZED and closes socket
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

    ws_bob
        .send(awc::ws::Message::Binary(
            encode_download_request("dl-revoked", attachment_id).into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        unwrap_error(read_next_binary(&mut ws_bob).await).code,
        "UNAUTHORIZED"
    );

    handle.stop(true).await;
}
