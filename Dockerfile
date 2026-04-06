FROM --platform=linux/amd64 rust:slim-bookworm AS builder

RUN apt update && apt install -y musl-tools musl-dev sqlite3 libsqlite3-dev

WORKDIR /usr/src

# Create blank project
RUN USER=root cargo new app

# We want dependencies cached, so copy those first.
COPY server/Cargo.toml server/Cargo.lock /usr/src/app/

ENV HOST='0.0.0.0'
ENV PORT='8080'

# Set the working directory
WORKDIR /usr/src/app

## Install target platform (Cross-Compilation) --> Needed for Alpine
RUN rustup target add x86_64-unknown-linux-musl

# This is a dummy build to get the dependencies cached.
RUN CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse cargo build --target x86_64-unknown-linux-musl --release

# Now copy in the rest of the sources
COPY server/src /usr/src/app/src/

## Touch main.rs to prevent cached release build
RUN touch /usr/src/app/src/main.rs

ARG STATIC_DIR=./server/static
ARG API_TOKEN=""
COPY ./server/templates /usr/local/bin/templates
COPY $STATIC_DIR /usr/local/bin/static/
ENV DOMAIN='erdmko.dev'
ENV API_TOKEN=$API_TOKEN
RUN cargo build --target x86_64-unknown-linux-musl --release

FROM --platform=linux/amd64 alpine:3.16.0 AS runtime
WORKDIR /usr/local/bin/
EXPOSE 8080
COPY --from=builder /usr/src/app/target/x86_64-unknown-linux-musl/release/server /usr/local/bin/server
COPY --from=builder /usr/local/bin/static/ /usr/local/bin/static/
COPY --from=builder /usr/local/bin/templates /usr/local/bin/templates/
VOLUME ["/usr/local/bin/db/"]
# ENV RUST_LOG=trace
# ENV RUST_BACKTRACE=1
CMD ["/usr/local/bin/server"]
