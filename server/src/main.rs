use actix_files;
use actix_web::dev::ServiceRequest;
use actix_web::http::header;
use actix_web::{middleware, web, App, HttpServer};
use actix_web_grants::GrantsMiddleware;
use db::check_token;
use env_logger;
use log::info;
use std::collections::HashSet;
use std::io::{Error, ErrorKind};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::{env, option_env};
use tera::Tera;

pub mod app;
pub mod chat;
pub mod db;
pub mod pages;

static TEMPLATES_GLOB: &str = "templates/**/*";
static BASE_PATH: Option<&'static str> = option_env!("BASE_PATH");
static BAZEL_STATIC: Option<&'static str> = option_env!("BAZEL_STATIC");
static HOST_RUN: Option<&'static str> = option_env!("HOST");
static PORT_RUN: Option<&'static str> = option_env!("PORT");

async fn get_static_from_root(
    ctx: web::Data<app::AppCtx>,
    req: actix_web::HttpRequest,
) -> actix_web::Result<actix_files::NamedFile> {
    match req.match_pattern() {
        Some(pattern) => {
            let mut full_path = ctx.static_path.clone();
            let path_list: Vec<&str> = pattern.split("/").collect();
            let file_name = path_list.last().unwrap_or(&"robots.txt");
            full_path.push(file_name);
            Ok(actix_files::NamedFile::open(full_path)?)
        }
        None => Err(actix_web::error::ErrorBadRequest("Wrong match")),
    }
}
const ROLE_ADMIN: &str = "ROLE_ADMIN";

async fn extract(req: &ServiceRequest) -> Result<HashSet<String>, actix_web::Error> {
    let headers = req.headers();
    let auth_header = headers.get(header::AUTHORIZATION);
    if let Some(token_header) = auth_header {
        let app_data: &web::Data<app::AppCtx> = req.app_data().expect("app broken");
        let token_str = token_header.to_str().expect("token is not str");
        let token_check_result = check_token(app_data, token_str).await?;
        if !token_check_result {
            return Ok(HashSet::default());
        }
        Ok(HashSet::from([ROLE_ADMIN.to_string()]))
    } else {
        Ok(HashSet::default())
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));
    let current_dir = env::current_dir().unwrap();
    let current_dir_str = current_dir.to_str().unwrap();
    info!("Starting http server from directory '{}'", &current_dir_str);
    let base_path = BASE_PATH.unwrap_or(&current_dir_str);
    let mut static_path = PathBuf::from(&base_path);
    let mut templates_path = PathBuf::from(&base_path);
    match BAZEL_STATIC {
        Some(bazel_path) => {
            info!("Is bazel build info - '{}'", bazel_path);
            static_path.push("assets");
            templates_path.push(bazel_path)
        }
        None => static_path.push("static"),
    }
    info!("Static path '{:?}'", static_path);
    let mut base_dir = templates_path.clone();
    templates_path.push(&TEMPLATES_GLOB);
    let host = HOST_RUN.unwrap_or("127.0.0.1");
    let port_str = PORT_RUN.unwrap_or("8080");
    let port = port_str.parse::<u16>().unwrap();
    let tera_path = &templates_path.to_str().unwrap();
    info!("Templates start {:?}", tera_path);
    let tera = Tera::new(tera_path).unwrap();
    info!("Templates done");
    let templates = Arc::new(RwLock::new(tera));
    info!("Srating server host '{}' port '{}'", host, port);
    let pool = db::init_db(&mut base_dir).await.map_err(|e| {
        info!("DB error {:?}", e);
        Error::new(ErrorKind::Other, "Pool error")
    })?;
    info!("DB pool is ready");
    HttpServer::new(move || {
        let auth = GrantsMiddleware::with_extractor(extract);
        App::new()
            .app_data(web::Data::new(app::AppCtx {
                static_path: static_path.clone(),
                pool: pool.clone(),
            }))
            .wrap(middleware::NormalizePath::trim())
            .wrap(middleware::Compress::default())
            .wrap(middleware::Logger::default())
            .wrap(auth)
            .app_data(templates.clone())
            .service(pages::main_page_handler)
            .service(pages::random_page_handler)
            .service(pages::base64_page_handler)
            .service(pages::image_page_handler)
            .service(pages::post_task_page_handler)
            .service(pages::post_task_status_handler)
            .service(pages::get_task_page_handler)
            .service(pages::post_image_upload_handler)
            .service(pages::tetris_page_handler)
            .service(pages::tennis_page_handler)
            .service(pages::ws_page_handler)
            .service(pages::chat_room_page_handler)
            .service(pages::chat_ws_page_handler)
            .service(pages::month_page_handler)
            .service(pages::month_no_page_handler)
            .service(pages::slugify_page_handler)
            .service(actix_files::Files::new("/static", &static_path).show_files_listing())
            .route("/robots.txt", web::get().to(get_static_from_root))
            .route("/favicon.ico", web::get().to(get_static_from_root))
            .route("/site.webmanifest", web::get().to(get_static_from_root))
            .route("/browserconfig.xml", web::get().to(get_static_from_root))
    })
    .bind((host, port))?
    .run()
    .await
}
