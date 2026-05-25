use super::utils;
use actix_web::{HttpRequest, Responder, get, web};
use chrono::Local;
use tera::Context;

fn get_months() -> Vec<&'static str> {
    vec![
        "Январь",
        "Февраль",
        "Март",
        "Апрель",
        "Май",
        "Июнь",
        "Июль",
        "Август",
        "Сентябрь",
        "Октябрь",
        "Ноябрь",
        "Декабрь",
    ]
}

fn create_ctx(no_string: String) -> Context {
    let mut ctx = Context::new();
    let months = get_months();
    ctx.insert("months", &months);
    if let Ok(no_num) = no_string.parse::<usize>() {
        let val = months.get(no_num - 1);
        if val.is_some() {
            ctx.insert("current", val.unwrap());
            ctx.insert("current_no", &no_string);
            ctx.insert("current_no_number", &no_num);
        }
    }
    return ctx;
}

#[get("/month/{number}")]
async fn month_no_page_handler(req: HttpRequest, no: web::Path<String>) -> impl Responder {
    let no_string = no.to_string();
    let ctx = create_ctx(no_string);
    return utils::render(req, "months.html", &ctx).await;
}

#[get("/month")]
async fn month_page_handler(req: HttpRequest) -> impl Responder {
    let local_time = Local::now();
    let no_string = format!("{}", local_time.format("%m"));
    let ctx = create_ctx(no_string);
    return utils::render(req, "months.html", &ctx).await;
}
