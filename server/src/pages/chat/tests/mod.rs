mod attachments;
mod helpers;
mod messaging;
mod voice;

use super::{
    chat_landing_page_handler, chat_room_page_handler, is_public_chat_room, sanitize_room_slug,
};
use crate::auth::SESSION_COOKIE_NAME;
use crate::auth::db::{create_session, record_payment_and_extend_access};
use crate::auth::payment::PaymentConfig;
use crate::pages::{
    base64_page_handler, main_page_handler, month_page_handler, random_page_handler,
    sitemap_xml_handler, slugify_page_handler, tennis_page_handler, tetris_page_handler,
};
use actix_web::{
    App,
    http::{StatusCode, header},
    test, web,
};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use tera::Tera;

fn load_test_templates_and_css() -> (Arc<RwLock<Tera>>, serde_json::Value) {
    let candidates = [
        (
            "server/templates/*",
            "assets/css/minified/style.module.json",
        ),
        ("templates/*", "../assets/css/minified/style.module.json"),
    ];
    for (tpl_glob, css_rel) in candidates {
        if let Ok(css_raw) = fs::read_to_string(css_rel) {
            let tera = Tera::new(tpl_glob).expect("Tera templates should parse cleanly");
            let css = serde_json::from_str(&css_raw).expect("CSS map should parse");
            return (Arc::new(RwLock::new(tera)), css);
        }
    }
    panic!("Failed to locate templates and style.module.json for test");
}

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
async fn sitemap_xml_lists_only_publicly_crawlable_pages_and_every_entry_resolves_200() {
    let (templates, css) = load_test_templates_and_css();
    let base_ctx = helpers::setup_ctx();
    let app_ctx = web::Data::new(crate::app::AppCtx {
        static_path: PathBuf::new(),
        pool: base_ctx.pool.clone(),
        css,
    });

    let app = test::init_service(
        App::new()
            .app_data(app_ctx)
            .app_data(templates)
            .service(sitemap_xml_handler)
            .service(main_page_handler)
            .service(chat_landing_page_handler)
            .service(chat_room_page_handler)
            .service(base64_page_handler)
            .service(random_page_handler)
            .service(month_page_handler)
            .service(slugify_page_handler)
            .service(tetris_page_handler)
            .service(tennis_page_handler),
    )
    .await;

    let req = test::TestRequest::get().uri("/sitemap.xml").to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = test::read_body(resp).await;
    let xml = std::str::from_utf8(&body).expect("utf-8 xml");

    assert!(xml.contains("<loc>https://erdmko.dev/chat</loc>"));
    assert!(!xml.contains("/chat/general"));
    assert!(!xml.contains("/chat/rust"));
    assert!(!xml.contains("/chat/web3"));
    assert!(!xml.contains("/chat/voice"));

    let mut loc_count = 0usize;
    for chunk in xml.split("<loc>").skip(1) {
        let loc = chunk.split("</loc>").next().expect("closing </loc>");
        let path = loc
            .strip_prefix("https://erdmko.dev")
            .expect("sitemap URL should start with site_url");
        let page_resp =
            test::call_service(&app, test::TestRequest::get().uri(path).to_request()).await;
        assert_eq!(
            page_resp.status(),
            StatusCode::OK,
            "sitemap path {path} must resolve anonymously to 200 OK"
        );
        loc_count += 1;
    }
    assert!(loc_count >= 8);
}

#[actix_web::test]
async fn chat_landing_and_room_copy_metadata_and_json_ld_match_paid_wallet_access() {
    let (templates, css) = load_test_templates_and_css();
    let base_ctx = helpers::setup_ctx();
    let app_ctx = web::Data::new(crate::app::AppCtx {
        static_path: PathBuf::new(),
        pool: base_ctx.pool.clone(),
        css,
    });
    let custom_cfg = PaymentConfig {
        chain_id: 11_155_111,
        rpc_url: "https://ethereum-sepolia-rpc.publicnode.com".to_string(),
        recipient_address: "0x2222222222222222222222222222222222222222".to_string(),
        min_payment_wei: 2_000_000_000_000_000, // 0.002 ETH
        access_duration_secs: 7 * 86_400,       // 7 days
    };

    let app = test::init_service(
        App::new()
            .app_data(app_ctx.clone())
            .app_data(web::Data::new(custom_cfg))
            .app_data(templates)
            .service(chat_landing_page_handler)
            .service(chat_room_page_handler),
    )
    .await;

    // 1. Anonymous /chat renders configured network, price, duration, and accurate JSON-LD
    let resp = test::call_service(&app, test::TestRequest::get().uri("/chat").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let html_bytes = test::read_body(resp).await;
    let html = std::str::from_utf8(&html_bytes).expect("utf-8 html");

    assert!(html.contains("0.002 ETH"));
    assert!(html.contains("Sepolia Testnet"));
    assert!(html.contains("7 days"));
    assert!(html.contains("0x2222222222222222222222222222222222222222"));
    assert!(html.contains("free off-chain"));
    assert!(html.contains("not end-to-end encrypted"));
    assert!(html.contains("not a privacy or room-access guarantee"));
    assert!(
        html.contains("<meta name=\"robots\" content=\"index, follow, max-image-preview:large\"/>")
    );
    assert!(html.contains("<link rel=\"canonical\" href=\"https://erdmko.dev/chat\"/>"));

    // Must not contain unsupported legacy promises or private RPC URL
    let lower_html = html.to_lowercase();
    assert!(!lower_html.contains("encrypted chat rooms"));
    assert!(!lower_html.contains("anonymous access"));
    assert!(!lower_html.contains("optional ethereum wallet"));
    assert!(!lower_html.contains("optional sign-in with ethereum"));
    assert!(!lower_html.contains("publicnode.com"));

    // Parse JSON-LD directly
    let ld_start = html
        .find("<script type=\"application/ld+json\">")
        .expect("JSON-LD script tag present")
        + "<script type=\"application/ld+json\">".len();
    let ld_end = html[ld_start..]
        .find("</script>")
        .expect("closing JSON-LD script tag")
        + ld_start;
    let ld_json: serde_json::Value =
        serde_json::from_str(html[ld_start..ld_end].trim()).expect("JSON-LD must be valid JSON");
    let graph = ld_json["@graph"].as_array().expect("@graph array");
    let web_app = &graph[0];
    assert_eq!(web_app["@type"], "WebApplication");
    assert_eq!(web_app["offers"]["price"], "0.002");
    assert_eq!(web_app["offers"]["priceCurrency"], "ETH");
    let faq = &graph[1];
    assert_eq!(faq["@type"], "FAQPage");
    assert_eq!(faq["mainEntity"].as_array().unwrap().len(), 3);

    // 2. Anonymous /chat?room=general uses noindex, follow + canonical /chat
    let invite_resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/chat?room=general")
            .to_request(),
    )
    .await;
    assert_eq!(invite_resp.status(), StatusCode::OK);
    let invite_bytes = test::read_body(invite_resp).await;
    let invite_html = std::str::from_utf8(&invite_bytes).unwrap();
    assert!(invite_html.contains("<meta name=\"robots\" content=\"noindex, follow\"/>"));
    assert!(invite_html.contains("<link rel=\"canonical\" href=\"https://erdmko.dev/chat\"/>"));
    assert!(invite_html.contains("#general"));

    // 3. Anonymous /chat/general redirects 303 to /chat?room=general
    let anon_room_resp = test::call_service(
        &app,
        test::TestRequest::get().uri("/chat/general").to_request(),
    )
    .await;
    assert_eq!(anon_room_resp.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        anon_room_resp.headers().get(header::LOCATION).unwrap(),
        "/chat?room=general"
    );

    // 4. Paid authenticated /chat/general emits noindex, nofollow (even for curated rooms)
    let wallet = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    let now_unix = chrono::Utc::now().timestamp();
    let session = {
        let conn = app_ctx.pool.get().unwrap();
        record_payment_and_extend_access(
            &conn,
            wallet,
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            "2000000000000000",
            now_unix,
            7 * 86_400,
        )
        .unwrap();
        create_session(&conn, wallet, now_unix, 3600).unwrap()
    };
    let paid_room_resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/chat/general")
            .insert_header((
                header::COOKIE,
                format!("{SESSION_COOKIE_NAME}={}", session.token),
            ))
            .to_request(),
    )
    .await;
    assert_eq!(paid_room_resp.status(), StatusCode::OK);
    let paid_room_bytes = test::read_body(paid_room_resp).await;
    let paid_room_html = std::str::from_utf8(&paid_room_bytes).unwrap();
    assert!(paid_room_html.contains("<meta name=\"robots\" content=\"noindex, nofollow\"/>"));
}
