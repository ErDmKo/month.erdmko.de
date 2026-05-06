use actix_web::HttpRequest;
use actix_web::{Responder, get, web};
use serde::{Deserialize, Serialize};
use slug::slugify;
use tera::Context;

use super::utils;

#[derive(Deserialize, Serialize)]
struct SlugifyParams {
    result: Option<String>,
    query: Option<String>,
}

#[get("/slugify")]
async fn slugify_page_handler(req: HttpRequest, info: web::Query<SlugifyParams>) -> impl Responder {
    let ref mut query_params = info.into_inner();
    query_params.result = match &query_params.query {
        None => None,
        Some(query_val) => {
            let res = slugify(query_val);
            Some(res)
        }
    };
    let ctx = Context::from_serialize(&query_params).unwrap();
    return utils::render(req, "slugify.html", &ctx).await;
}
