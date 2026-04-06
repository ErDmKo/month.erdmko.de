FROM --platform=linux/amd64 rust:slim-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN USER=root cargo new app

COPY server/Cargo.toml server/Cargo.lock /usr/src/app/

ENV HOST='0.0.0.0'
ENV PORT='8080'

WORKDIR /usr/src/app
RUN CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse cargo build --release

COPY server/src /usr/src/app/src/
RUN touch /usr/src/app/src/main.rs

ARG STATIC_DIR=./server/static
ARG API_TOKEN=""
COPY ./server/templates /usr/local/bin/templates
COPY $STATIC_DIR /usr/local/bin/static/
ENV DOMAIN='erdmko.dev'
ENV API_TOKEN=$API_TOKEN
RUN CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse cargo build --release

FROM --platform=linux/amd64 debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin/
EXPOSE 8080
COPY --from=builder /usr/src/app/target/release/server /usr/local/bin/server
COPY --from=builder /usr/local/bin/static/ /usr/local/bin/static/
COPY --from=builder /usr/local/bin/templates /usr/local/bin/templates/
VOLUME ["/usr/local/bin/db/"]
CMD ["/usr/local/bin/server"]
