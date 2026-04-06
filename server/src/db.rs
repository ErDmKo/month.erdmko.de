use actix_web::{error, web};
use log;
use r2d2_sqlite::{self, SqliteConnectionManager};
use rusqlite::params_from_iter;
use rusqlite::types::ValueRef;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::app::AppCtx;
use crate::app::Pool;

pub static TABLE_NAME: &str = "prompt";

#[derive(Debug, Serialize, Deserialize)]
pub struct CountResult {
    c: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlResult {
    pub id: i32,
    pub prompt: String,
    pub data: Option<Vec<u8>>,
    // state = 0 - pending execute
    // state = 1 - executing
    // state = 2 - success
    // state = 3 - fail
    pub state: i32,
}

fn init_pool(base_dir: &mut PathBuf) -> Result<Pool, r2d2::Error> {
    base_dir.push("db");
    base_dir.push("main.db");
    log::info!("Db pool start {:?}", base_dir);
    let manager = SqliteConnectionManager::file(base_dir);
    let pool = Pool::new(manager)?;
    Ok(pool)
}

pub async fn init_db(base_dir: &mut PathBuf) -> Result<Pool, rusqlite::Error> {
    log::info!("Init db");
    let pool = init_pool(base_dir).map_err(|e| {
        let error_text = format!("Pool error {e:?}");
        rusqlite::Error::InvalidParameterName(error_text)
    })?;
    let conn = pool.get().unwrap();

    // Keep chat data across restarts; schema init/migrations must be non-destructive.
    conn.execute(format!("DROP TABLE IF EXISTS {TABLE_NAME}").as_str(), ())?;
    conn.execute("DROP TABLE IF EXISTS token", ())?;

    let create_query = format!(
        "\
            CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
            id    INTEGER PRIMARY KEY,
            promt  TEXT NOT NULL,
            datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            data BLOB,
            state INTEGER DEFAULT 0
    )"
    );
    conn.execute(&create_query, ())?;

    let token_query = "
       CREATE TABLE IF NOT EXISTS token (
       id    INTEGER PRIMARY KEY,
       token  TEXT NOT NULL,
       datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );";
    conn.execute(token_query, ())?;

    crate::chat::db::init_chat_schema(&conn)?;

    let random_seed = rand::random::<u64>().to_string();
    let token = format!("im_{random_seed}");
    log::info!("Admin token {:?}", token);
    conn.execute(
        "INSERT INTO token (token) VALUES (?1)",
        (token,),
    )?;
    conn.execute(
        format!("INSERT INTO {TABLE_NAME} (promt) VALUES (?1)").as_str(),
        ("1girl, oshi no ko, solo, upper body, v, smile, looking at viewer, outdoors, night",),
    )?;
    Ok(pool)
}

pub async fn check_token(app_ctx: &web::Data<AppCtx>, token: &str) -> actix_web::Result<bool> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    let q = "SELECT id as c from token where token=?1";
    let mut stmt = conn.prepare(q).map_err(error::ErrorInternalServerError)?;
    let r = stmt
        .query_map((token,), |row| Ok(CountResult { c: row.get("c")? }))
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(error::ErrorInternalServerError)?;

    Ok(!r.is_empty())
}

pub async fn insert_promt(app_ctx: &web::Data<AppCtx>, promt: &String) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!("INSERT into {TABLE_NAME} (promt) VALUES (?1)").as_str(),
        (promt,),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    conn.execute(
        format!(
            "DELETE FROM {TABLE_NAME}
        WHERE id NOT IN (
            SELECT id
            FROM {TABLE_NAME}
            ORDER BY id DESC
            LIMIT 10
        )"
        )
        .as_str(),
        (),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(1)
}

pub async fn insert_data_promt(
    app_ctx: &web::Data<AppCtx>,
    id: &String,
    data: Vec<u8>,
) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!("UPDATE {TABLE_NAME} set data=?1, state=2 where id=?2").as_str(),
        (data, id),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(1)
}

pub async fn insert_status_promt(
    app_ctx: &web::Data<AppCtx>,
    id: &String,
    status: &String,
) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    conn.execute(
        format!("UPDATE {TABLE_NAME} set state=?1 where id=?2").as_str(),
        (status, id),
    )
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(1)
}

pub async fn delete_promt(app_ctx: &web::Data<AppCtx>, id: &i32) -> actix_web::Result<i32> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    let delete_qury = format!("DELETE from {TABLE_NAME} where id = ?1");
    conn.execute(&delete_qury, (id,)).map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;
    Ok(*id)
}

pub async fn query_promts(
    app_ctx: web::Data<AppCtx>,
    state: Option<i32>,
) -> actix_web::Result<Vec<SqlResult>> {
    let pool = app_ctx.pool.clone();
    let conn = web::block(move || pool.get())
        .await?
        .map_err(error::ErrorInternalServerError)?;
    let mut lis = vec![];

    let query_result = web::block(move || {
        let (params, query) = match state {
            Some(status) => {
                let q = format!(
                    "\
                    SELECT id, promt, state, data \
                    FROM {TABLE_NAME} \
                    WHERE state=?1 \
                    order by datetime desc"
                );
                lis.push(status);
                let p = params_from_iter(lis.iter());
                (p, q)
            }
            None => {
                let q = format!(
                    "\
                    SELECT id, promt, state, data \
                    FROM {TABLE_NAME} \
                    order by datetime desc"
                );
                (params_from_iter([].iter()), q)
            }
        };
        let mut stmt = conn.prepare(&query)?;
        stmt.query_map(params, |row| {
            let bytes = row.get_ref("data")?;
            Ok(SqlResult {
                id: row.get("id")?,
                prompt: row.get("promt")?,
                state: row.get("state")?,
                data: match bytes {
                    ValueRef::Blob(byte) => Some(byte.to_vec()),
                    _ => None,
                },
            })
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
    })
    .await?
    .map_err(|e| {
        log::error!("{:?}", e);
        error::ErrorBadRequest("query error")
    })?;

    Ok(query_result)
}
