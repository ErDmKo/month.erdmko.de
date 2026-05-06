use super::utils;
use actix_web::{HttpRequest, Responder, get, web};
use rand::prelude::*;
use rand::thread_rng;
use serde::{Deserialize, Serialize};
use tera::Context;

#[derive(Deserialize, Serialize)]
pub struct RandomParams {
    min: Option<String>,
    max: Option<String>,
}

static START: i32 = 0;
static END: i32 = 100;

#[get("/random")]
pub async fn random_page_handler(
    req: HttpRequest,
    info: web::Query<RandomParams>,
) -> impl Responder {
    let mut ctx = Context::new();
    let query = info.into_inner();
    let start_val = match &query {
        RandomParams {
            min: Some(min_val), ..
        } => min_val.parse::<i32>().unwrap_or(START),
        _ => START,
    };
    let stop_val = match &query {
        RandomParams {
            max: Some(max_val), ..
        } => max_val.parse::<i32>().unwrap_or(END),
        _ => END,
    };
    let mut range = start_val..stop_val;
    if range.is_empty() {
        range = START..END
    };
    ctx.insert("result", &thread_rng().gen_range(range));
    ctx.insert("min_val", &start_val);
    ctx.insert("max_val", &stop_val);
    return utils::render(req, "random.html", &ctx).await;
}
