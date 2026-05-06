use super::helpers::*;
use rand::random;

#[actix_web::test]
async fn upload_happy_path() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    let file_data = b"hello upload world";
    ws.send(awc::ws::Message::Text(
        json!({
            "type":"upload_start","requestId":"up-1","messageId":msg.id,
            "filename":"test.txt","size":file_data.len(),"mimeType":"text/plain"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let ready = read_next_text(&mut ws).await;
    assert_eq!(ready["type"], "upload_ready");
    let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

    ws.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 0, file_data).into(),
    ))
    .await
    .unwrap();
    ws.send(awc::ws::Message::Text(
        json!({
            "type":"upload_end","requestId":"up-1","uploadId":upload_id
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let done = find_text(&mut ws, 5, |v| v["type"] == "upload_done")
        .await
        .expect("upload_done");
    assert_eq!(done["attachment"]["filename"], "test.txt");
    assert!(done["attachment"]["id"].as_i64().unwrap() > 0);
    handle.stop(true).await;
}

#[actix_web::test]
async fn download_happy_path() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
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

    ws.send(awc::ws::Message::Text(
        json!({
            "type":"download_request","requestId":"dl-1","attachmentId":attachment_id
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let start = find_text(&mut ws, 5, |v| v["type"] == "download_start")
        .await
        .expect("download_start");
    let total_chunks = start["totalChunks"].as_u64().unwrap() as usize;

    let mut received: Vec<u8> = Vec::new();
    for _ in 0..total_chunks {
        let bin = read_next_binary(&mut ws).await.expect("binary chunk");
        received.extend(extract_download_data(&bin));
    }

    let end = find_text(&mut ws, 5, |v| v["type"] == "download_end")
        .await
        .expect("download_end");
    assert_eq!(end["attachmentId"], attachment_id);
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
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Text(
        json!({
            "type":"upload_start","requestId":"up-oo","messageId":msg.id,
            "filename":"f.bin","size":10,"mimeType":"application/octet-stream"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let ready = read_next_text(&mut ws).await;
    let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

    ws.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 1, &[0u8; 5]).into(),
    ))
    .await
    .unwrap();

    let err = find_text(&mut ws, 5, |v| v["type"] == "error")
        .await
        .expect("error");
    assert_eq!(err["code"], "UPLOAD_CHUNK_OUT_OF_ORDER");
    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_early_end() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Text(
        json!({
            "type":"upload_start","requestId":"up-early","messageId":msg.id,
            "filename":"f.bin","size":10,"mimeType":"application/octet-stream"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let ready = read_next_text(&mut ws).await;
    let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

    ws.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 0, &[1u8; 5]).into(),
    ))
    .await
    .unwrap();
    ws.send(awc::ws::Message::Text(
        json!({
            "type":"upload_end","requestId":"up-early","uploadId":upload_id
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let err = find_text(&mut ws, 5, |v| v["type"] == "error")
        .await
        .expect("error");
    assert_eq!(err["code"], "UPLOAD_INCOMPLETE");
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

    let err = find_text(&mut ws, 5, |v| v["type"] == "error")
        .await
        .expect("error");
    assert_eq!(err["code"], "UPLOAD_NOT_FOUND");
    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_session_limit() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    for i in 0..crate::attachments::MAX_PENDING_UPLOADS_PER_SESSION {
        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":format!("up-{i}"),"messageId":msg.id,
                "filename":"f.bin","size":5,"mimeType":"application/octet-stream"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let r = read_next_text(&mut ws).await;
        assert_eq!(r["type"], "upload_ready");
    }

    ws.send(awc::ws::Message::Text(
        json!({
            "type":"upload_start","requestId":"up-limit","messageId":msg.id,
            "filename":"f.bin","size":5,"mimeType":"application/octet-stream"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let err = find_text(&mut ws, 5, |v| v["type"] == "error")
        .await
        .expect("error");
    assert_eq!(err["code"], "UPLOAD_LIMIT_EXCEEDED");
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

    ws.send(awc::ws::Message::Text(
        json!({
            "type":"download_request","requestId":"dl-scope","attachmentId":attachment_id
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let err = find_text(&mut ws, 5, |v| v["type"] == "error")
        .await
        .expect("error");
    assert_eq!(err["code"], "ATTACHMENT_NOT_FOUND");
    handle.stop(true).await;
}

#[actix_web::test]
async fn disconnect_cancels_upload() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx.clone());

    {
        let mut ws = ws_join!(addr, room, "alice");
        ws.send(awc::ws::Message::Text(
            json!({
                "type":"upload_start","requestId":"up-dc","messageId":msg.id,
                "filename":"f.bin","size":10,"mimeType":"application/octet-stream"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let r = read_next_text(&mut ws).await;
        assert_eq!(r["type"], "upload_ready");
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
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws1 = ws_join!(addr, room, "alice");
    let mut ws2 = ws_join!(addr, room, "bob");

    let file_data = b"broadcast test";
    ws1.send(awc::ws::Message::Text(
        json!({
            "type":"upload_start","requestId":"up-bc","messageId":msg.id,
            "filename":"bc.txt","size":file_data.len(),"mimeType":"text/plain"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let ready = read_next_text(&mut ws1).await;
    let upload_id = ready["uploadId"].as_u64().unwrap() as u32;

    ws1.send(awc::ws::Message::Binary(
        encode_upload_chunk_frame(upload_id, 0, file_data).into(),
    ))
    .await
    .unwrap();
    ws1.send(awc::ws::Message::Text(
        json!({
            "type":"upload_end","requestId":"up-bc","uploadId":upload_id
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let done1 = find_text(&mut ws1, 5, |v| v["type"] == "upload_done")
        .await
        .expect("ws1 upload_done");
    let done2 = find_text(&mut ws2, 5, |v| v["type"] == "upload_done")
        .await
        .expect("ws2 upload_done");
    assert_eq!(done1["attachment"]["filename"], "bc.txt");
    assert_eq!(done2["attachment"]["filename"], "bc.txt");
    assert_eq!(done1["attachment"]["id"], done2["attachment"]["id"]);
    handle.stop(true).await;
}

#[actix_web::test]
async fn upload_start_rejects_oversized_size() {
    let ctx = setup_ctx();
    let room = format!("room-{}", random::<u64>());
    chat_db::create_room_if_not_exists(&ctx, &room)
        .await
        .unwrap();
    let msg = chat_db::insert_message(&ctx, &room, "u1", "alice", "hi")
        .await
        .unwrap();
    let (addr, handle) = spawn_server!(ctx);
    let mut ws = ws_join!(addr, room, "alice");

    ws.send(awc::ws::Message::Text(
        json!({
            "type":"upload_start","requestId":"up-big","messageId":msg.id,
            "filename":"big.bin",
            "size": crate::attachments::MAX_ATTACHMENT_SIZE_BYTES + 1,
            "mimeType":"application/octet-stream"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let err = find_text(&mut ws, 5, |v| v["type"] == "error")
        .await
        .expect("error");
    assert_eq!(err["code"], "UPLOAD_TOO_LARGE");
    handle.stop(true).await;
}
