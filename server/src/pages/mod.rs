mod base64;
mod main_page;
mod months;
mod random;
mod slugify;
mod some_js_pages;
mod utils;
pub use self::base64::base64_page_handler;
pub use self::base64::image_page_handler;
pub use self::base64::post_image_page_handler;
pub use self::main_page::main_page_handler;
pub use self::months::month_no_page_handler;
pub use self::months::month_page_handler;
pub use self::random::random_page_handler;
pub use self::slugify::slugify_page_handler;
pub use self::some_js_pages::tennis_page_handler;
pub use self::some_js_pages::tetris_page_handler;
pub use self::some_js_pages::ws_page_handler;
