use actix_web::HttpRequest;
use actix_web::{get, web, Responder};
use base64::{decode, encode};
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

#[get("/base64")]
async fn base64_page_handler(req: HttpRequest, info: web::Query<Base64Params>) -> impl Responder {
    let ref mut i = info.into_inner();
    match &i.query {
        None => Some(String::from("")),
        Some(query_val) => {
            let a: Option<String> = match &i.action {
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
            i.result = a;
            None
        }
    };
    let ctx = &Context::from_serialize(&i).unwrap();
    return utils::render(req, "base64.html", &ctx).await;
}