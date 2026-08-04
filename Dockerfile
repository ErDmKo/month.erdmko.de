# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 gcr.io/bazel-public/bazel:9.1.0 AS builder_linux

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libgstreamer-plugins-base1.0-dev \
        libgstreamer1.0-dev \
        libsqlite3-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . .
RUN --mount=type=cache,target=/root/.cache/bazel,sharing=locked \
    bazel build //server:server \
    && mkdir /workspace/dist \
    && cp -L bazel-bin/server/server /workspace/dist/server \
    && cp -aL bazel-bin/server/server.runfiles/_main/assets /workspace/dist/assets \
    && cp -aL bazel-bin/assets/css/minified /workspace/dist/assets/css/minified \
    && cp -aL bazel-bin/server/server.runfiles/_main/server/templates /workspace/dist/templates

FROM --platform=linux/amd64 debian:bookworm-slim AS runtime_linux

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        libgstreamer-plugins-base1.0-0 \
        libgstreamer1.0-0 \
        libsqlite3-0 \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
EXPOSE 8080
COPY --from=builder_linux /workspace/dist/server /usr/local/bin/server
COPY --from=builder_linux /workspace/dist/assets /app/assets
COPY --from=builder_linux /workspace/dist/templates /app/server/templates
VOLUME ["/app/server/db/"]

ENV HOST=0.0.0.0
ENV PORT=8080

CMD ["/usr/local/bin/server"]
