use actix_web::{HttpRequest, HttpResponse, Result, error};
use log::error;
use std::sync::{Arc, RwLock};
use tera::{Context, Tera};

pub async fn render(req: HttpRequest, template: &str, ctx: &Context) -> Result<HttpResponse> {
    let data: Option<&Arc<RwLock<Tera>>> = req.app_data();
    if let Some(eng) = data {
        let engine = eng.read().unwrap();
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
