use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use log::error;
use std::sync::{Arc, RwLock};
use tera::{Context, Tera};

use crate::app::AppCtx;
use crate::version;

pub fn site_url() -> String {
    let raw = std::env::var("DOMAIN")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| option_env!("DOMAIN").map(str::to_string))
        .unwrap_or_else(|| "erdmko.dev".to_string());
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

pub async fn render(req: HttpRequest, template: &str, ctx: &Context) -> Result<HttpResponse> {
    let tera_data: Option<&Arc<RwLock<Tera>>> = req.app_data();
    let app_ctx: Option<&web::Data<AppCtx>> = req.app_data();
    if let (Some(eng), Some(app)) = (tera_data, app_ctx) {
        let engine = eng.read().unwrap();
        let mut ctx = ctx.clone();
        ctx.insert("css", &app.css);
        if !ctx.contains_key("asset_version") {
            ctx.insert("asset_version", version::short_commit(version::commit()));
        }
        let base = site_url();
        if !ctx.contains_key("site_url") {
            ctx.insert("site_url", &base);
        }
        if !ctx.contains_key("canonical_url") {
            let path = req.path();
            let canonical = if path.is_empty() || path == "/" {
                format!("{base}/")
            } else {
                format!("{base}{path}")
            };
            ctx.insert("canonical_url", &canonical);
        }
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
