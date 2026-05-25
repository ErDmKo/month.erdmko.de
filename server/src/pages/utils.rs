use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use log::error;
use std::sync::{Arc, RwLock};
use tera::{Context, Tera};

use crate::app::AppCtx;

pub async fn render(req: HttpRequest, template: &str, ctx: &Context) -> Result<HttpResponse> {
    let tera_data: Option<&Arc<RwLock<Tera>>> = req.app_data();
    let app_ctx: Option<&web::Data<AppCtx>> = req.app_data();
    if let (Some(eng), Some(app)) = (tera_data, app_ctx) {
        let engine = eng.read().unwrap();
        let mut ctx = ctx.clone();
        ctx.insert("css", &app.css);
        let body = engine.render(template, &ctx);
        return match body {
            Ok(v) => Ok(HttpResponse::Ok().body(v)),
            Err(e) => {
                error!("Template error {:?}", e);
                Err(error::ErrorBadRequest("Template error"))
            }
        };
    }
    Err(error::ErrorBadRequest("Error"))
}
