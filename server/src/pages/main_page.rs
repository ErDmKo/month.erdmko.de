use actix_web::HttpRequest;
use actix_web::{get, Responder};
use serde::Serialize;
use tera::Context;
use chrono::{Local, Datelike};

use super::utils;

#[derive(Serialize)]
struct MainPageContext<T> {
    addreses: Vec<T>,
    tools: Vec<T>,
    games: Vec<T>,
    is_snow: bool,
}

#[derive(Serialize)]
struct MainPageLink {
    name: &'static str,
    href: &'static str,
    text: &'static str,
}

#[derive(Serialize)]
struct MainPageLinkString {
    name: String,
    href: String,
    text: String,
}

impl From<MainPageLink> for MainPageLinkString {
    fn from(link: MainPageLink) -> Self {
        Self {
            name: link.name.to_string(),
            href: link.href.to_string(),
            text: link.text.to_string(),
        }
    }
}

impl From<MainPageContext<MainPageLink>> for MainPageContext<MainPageLinkString> {
    fn from(context: MainPageContext<MainPageLink>) -> Self {
        Self {
            addreses: context.addreses.into_iter().map(Into::into).collect(),
            tools: context.tools.into_iter().map(Into::into).collect(),
            games: context.games.into_iter().map(Into::into).collect(),
            is_snow: context.is_snow
        }
    }
}

fn get_page_ctx() -> MainPageContext<MainPageLinkString> {
    let page_info = MainPageContext {
        is_snow: match Local::now().month() {
            12 | 1 | 2 => true,
            _ => false,
        },
        addreses: vec![
            MainPageLink {
                name: "Email",
                href: "mailto:erdmko@gmail.com",
                text: "erdmko@gmail.com",
            },
            MainPageLink {
                name: "Telegram",
                href: "https://t.me/erdmko",
                text: "//t.me/erdmko",
            },
            MainPageLink {
                name: "GitHub",
                href: "https://github.com/ErDmKo",
                text: "//github.com/ErDmKo",
            },
            MainPageLink {
                name: "LinkedIn",
                href: "https://www.linkedin.com/in/erdmko/",
                text: "//www.linkedin.com/in/erdmko/",
            },
            MainPageLink {
                name: "X",
                href: "https://x.com/ErDmKo",
                text: "//x.com/ErDmKo",
            },
            MainPageLink {
                name: "Twitch",
                href: "https://www.twitch.tv/erdmko",
                text: "//twitch.tv/erdmko",
            },
            MainPageLink {
                name: "My personal blog",
                href: "/blog",
                text: "/blog",
            },
        ],
        tools: vec![
            MainPageLink {
                name: "Base64 ecoder/decoder",
                href: "/base64",
                text: "base64",
            },
            MainPageLink {
                name: "Random generator",
                href: "/random",
                text: "Random",
            },
            MainPageLink {
                name: "Months names",
                href: "/month",
                text: "Month",
            },
            MainPageLink {
                name: "Slug generator",
                href: "/slugify",
                text: "Slugify",
            },
            MainPageLink {
                name: "Catalog of items",
                href: "/catalog",
                text: "Catalog",
            },
            MainPageLink {
                name: "General chat room",
                href: "/chat/general",
                text: "Open chat",
            },
        ],
        games: vec![
            MainPageLink {
                name: "Tetris game",
                href: "/tetris",
                text: "tetris 🟥🟥🟥",
            },
            MainPageLink {
                name: "Ping pong game",
                href: "/tennis",
                text: "Tennis 🏓",
            },
        ],
    };
    let string_context: MainPageContext<MainPageLinkString> = page_info.into();
    return string_context;
}

#[get("/")]
pub async fn main_page_handler(req: HttpRequest) -> impl Responder {
    let page_ctx = get_page_ctx();
    let ctx = Context::from_serialize(page_ctx).unwrap();
    return utils::render(req, "main.html", &ctx).await;
}
