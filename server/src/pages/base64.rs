use crate::app::AppCtx;
use crate::db::{delete_promt, insert_data_promt, insert_promt, insert_status_promt, query_promts};
use actix_multipart::Multipart;
use actix_web::http::StatusCode;
use actix_web::web::Redirect;
use actix_web::{HttpRequest, HttpResponse, Responder, Result, get, post, web};
use actix_web_grants::protect;
use base64::{decode, encode};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tera::Context;

use super::utils;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Actions {
    Encode,
    Decode,
}
#[derive(Deserialize, Serialize)]
struct Base64Params {
    result: Option<String>,
    query: Option<String>,
    action: Option<Actions>,
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
enum ImageActions {
    Generate,
}
#[derive(Deserialize, Serialize, Debug, Default)]
struct ImageParams {
    id: Option<String>,
    status: Option<String>,
    error: Option<String>,
    promt: Option<String>,
    delete: Option<i32>,
    data: Option<Vec<u8>>,
    token: Option<String>,
}

#[derive(Deserialize, Serialize, Debug)]
struct Task {
    id: i32,
    state: i32,
    prompt: String,
    image: Option<String>,
}

#[derive(Deserialize, Serialize, Debug)]
struct JSONError {
    error: String,
}

// static TOKEN: Option<&'static str> = option_env!("API_TOKEN");

#[post("/upload_image")]
#[protect("ROLE_ADMIN")]
async fn post_image_upload_handler(
    app_ctx: web::Data<AppCtx>,
    mut payload: Multipart,
) -> Result<impl Responder> {
    let mut file_data = Vec::<u8>::new();
    let mut task_id: Option<String> = None;
    while let Some(item) = payload.next().await {
        let mut field = item?;
        let content_disposition = field.content_disposition();
        let field_name = content_disposition.get_name().unwrap();
        match field_name {
            "file" => {
                while let Some(res_chunk) = field.next().await {
                    let chunk = res_chunk?;
                    file_data.extend_from_slice(&chunk);
                }
            }
            "task" => {
                let mut bytes = Vec::<u8>::new();
                while let Some(res_bytes) = field.next().await {
                    let new_bytes = res_bytes?;
                    bytes.extend_from_slice(&new_bytes)
                }
                task_id = String::from_utf8(bytes).ok();
            }
            _ => {}
        }
    }
    if file_data.len() == 0 {
        return Ok(HttpResponse::BadRequest().json(ImageParams {
            status: Some("Field \"file\" is empty".to_string()),
            ..ImageParams::default()
        }));
    }
    if let Some(tid) = task_id {
        log::info!("Task id '{:?}'", tid);
        log::info!("Image len '{:?}'", file_data.len());
        insert_data_promt(&app_ctx, &tid, file_data).await?;
    } else {
        return Ok(HttpResponse::Ok().json(ImageParams {
            status: Some("Task id is missing".to_string()),
            ..ImageParams::default()
        }));
    }
    Ok(HttpResponse::Ok().json(ImageParams {
        status: Some("Image uploaded".to_string()),
        ..ImageParams::default()
    }))
}

#[post("/task/status")]
#[protect("ROLE_ADMIN")]
async fn post_task_status_handler(
    app_ctx: web::Data<AppCtx>,
    info: web::Json<ImageParams>,
) -> Result<impl Responder> {
    let params = info.into_inner();
    if let ImageParams {
        id: Some(task_id),
        status: Some(task_status),
        ..
    } = params
    {
        insert_status_promt(&app_ctx, &task_id, &task_status).await?;
    } else {
        return Ok(HttpResponse::BadRequest().json(ImageParams {
            status: Some("Wrong request".to_string()),
            ..ImageParams::default()
        }));
    }

    Ok(HttpResponse::Ok().json(ImageParams {
        status: Some("Status updated".to_string()),
        ..ImageParams::default()
    }))
}

#[get("/task")]
#[protect("ROLE_ADMIN")]
async fn get_task_page_handler(app_ctx: web::Data<AppCtx>) -> Result<impl Responder> {
    let query_result = query_promts(app_ctx, Some(0)).await?;
    Ok(HttpResponse::Ok().json(query_result))
}

#[post("/task")]
async fn post_task_page_handler(
    app_ctx: web::Data<AppCtx>,
    info: web::Form<ImageParams>,
) -> Result<impl Responder> {
    let ref mut query_params = info.into_inner();
    if let Some(id) = &query_params.delete {
        let query_result = delete_promt(&app_ctx, id).await?;
        log::info!("{:#?}", query_result);
    }

    match query_params.promt.as_deref() {
        Some("") => (),
        None => (),
        Some(promt) => {
            let query_result = insert_promt(&app_ctx, &String::from(promt)).await?;
            log::info!("{:#?}", query_result);
        }
    }

    Result::Ok(Redirect::to("/image").using_status_code(StatusCode::FOUND))
}

#[get("/image")]
async fn image_page_handler(app_ctx: web::Data<AppCtx>, req: HttpRequest) -> impl Responder {
    let mut ctx = Context::new();
    let query_result = query_promts(app_ctx, None).await?;
    let tasks = query_result
        .into_iter()
        .map(|row| Task {
            id: row.id,
            prompt: row.prompt,
            state: row.state,
            image: match row.data {
                Some(bytes) => Some(format!("data:image/png;base64,{}", encode(bytes))),
                _ => None,
            },
        })
        .collect::<Vec<_>>();
    ctx.insert("prompts", &tasks);
    return utils::render(req, "image.html", &ctx).await;
}

#[get("/base64")]
async fn base64_page_handler(req: HttpRequest, info: web::Query<Base64Params>) -> impl Responder {
    let ref mut query_params = info.into_inner();
    match &query_params.query {
        None => Some(String::from("")),
        Some(query_val) => {
            let string_result: Option<String> = match &query_params.action {
                Some(Actions::Decode) => {
                    let mut is_ok = true;
                    let decoded_bytes = decode(query_val).unwrap_or_else(|_| {
                        is_ok = false;
                        vec![0]
                    });
                    let decoded_str = String::from_utf8(decoded_bytes).unwrap_or_else(|_| {
                        is_ok = false;
                        String::from("")
                    });
                    Some(if is_ok {
                        decoded_str
                    } else {
                        String::from("Wrong value")
                    })
                }
                Some(Actions::Encode) => {
                    let encoded_string = encode(query_val);
                    Some(encoded_string)
                }
                None => None,
            };
            query_params.result = string_result;
            None
        }
    };
    let ctx = &Context::from_serialize(&query_params).unwrap();
    return utils::render(req, "base64.html", &ctx).await;
}
