# WhatAmonth

My homepage app

## Deploy command sequence

Requires Docker, Node.js `24.14.1` (pinned in `.tool-versions`), Bazel, and
SSH access to the Ansible inventory host. SSH authentication must already be
configured for that host (for example, through the SSH agent or `~/.ssh/config`).

The container image builds `//server:server` with Bazel inside a Linux Docker
builder. This packages the Bazel binary and its runfiles, including frontend
assets, templates, generated protocol code, and the GStreamer runtime needed
for voice calls.

```bash
npm run build
npm run save
uvx --from ansible-core ansible-playbook ansible/push.yaml \
  -i ansible/inventory.yaml
```

Or just

```bash
npm run pub
```

### Voice deployment requirements

Voice runtime settings are defined in `ansible/inventory.yaml`. The deployment
publishes TCP `8080` and UDP `50000:50100`, and injects `PUBLIC_IP`,
`RTP_PORT_MIN`, and `RTP_PORT_MAX` into the container. Keep the public IP and
port range in inventory rather than in the image.

The Compose stack also sets `GST_DEBUG=3` by default, so GStreamer warnings
such as `not-linked` flow errors appear in `docker logs my_app`. Override
`GST_DEBUG` in `/opt/month/.env` if more or less GStreamer logging is needed.

Before deploying, allow UDP `50000:50100` in the VPS firewall and in the
provider firewall/security group. On a UFW-managed VPS, run:

```bash
ufw allow 50000:50100/udp
```

The public site must use HTTPS for browser microphone access. Its reverse proxy
must forward `/ws/chat/...` WebSocket upgrade connections without buffering or
an idle timeout that interrupts reconnects.

After deployment, verify the selected settings and port publishing:

```bash
ssh root@erdmko.dev \
  'docker inspect my_app --format "{{range .Config.Env}}{{println .}}{{end}}"; docker port my_app'
```

The application startup log includes the effective `Voice config` line. For an
ICE failure, collect that log and browser ICE candidate details before changing
WebRTC settings. Networks that require a relay are unsupported until a TURN
service is explicitly introduced.

### Health check

`GET /healthz` returns `200 OK` while the application HTTP process is accepting
requests. Use it for external availability monitoring:

```bash
curl --fail --silent --show-error https://erdmko.dev/healthz
```

This endpoint does not verify active voice sessions or media connectivity.

### Version check

`GET /version` returns the git metadata baked into the running image:

```bash
curl --fail --silent --show-error https://erdmko.dev/version
```

```json
{
    "branch": "master",
    "commit": "e8eea03...",
    "short_commit": "e8eea03",
    "dirty": false,
    "build_time": "2026-08-21T15:44:12.345Z"
}
```

`npm run build` collects the branch, commit, and dirty state from the local git
checkout and passes them to the Docker build, because `.git` is excluded from
the Docker build context. The values are stamped into the binary by Bazel via
`script/workspace_status.ts` and `server/version.env`; plain `bazel build`
reads git directly and needs no Docker involvement. Local builds report the
commit time as `build_time`; image builds report the actual build time. Use
this endpoint to confirm which revision is live before/after a deployment.

The Compose deployment also runs `autoheal`, which restarts `my_app` after
three consecutive failed health checks. The watchdog has Docker socket access,
so it is restricted to containers explicitly labelled `autoheal: "true"`.

## Local development setup

`.bazelrc` uses `common --enable_platform_specific_config`, so Bazel
automatically applies `build:linux` or `build:macos` based on the host OS.

- **Linux:** no `PKG_CONFIG_PATH` override; `pkg-config` uses the distribution
  defaults.
- **macOS:** the `build:macos` config adds both Homebrew prefixes
  (`/opt/homebrew` for Apple Silicon, `/usr/local` for Intel) to
  `PKG_CONFIG_PATH` and `PATH`.

Common requirements:

| Tool | Version | Notes |
|---|---|---|
| Bazel | `9.1.0` | Pinned in `.bazelversion`; Bazelisk is recommended |
| Node.js | `24.14.1` | Pinned in `.tool-versions`; runs `script/workspace_status.ts` during Bazel builds |
| Git | any | Supplies branch/commit metadata to `//server:server` |
| C/C++ toolchain | system | GCC on Linux, Xcode clang on macOS |
| pkg-config | system | Discovers GStreamer |
| GStreamer | 1.x | Development headers plus base/good plugins |

### Linux (Debian/Ubuntu)

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  pkg-config \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-tools
```

### macOS

```bash
xcode-select --install
brew install pkg-config gstreamer gst-plugins-base gst-plugins-good

# Node 24.14.1, via the pinned .tool-versions:
mise install        # or: asdf install
# Without mise/asdf:
# brew install node@24

# Bazelisk reads .bazelversion:
brew install bazelisk
```

### Verify the setup

```bash
pkg-config --modversion gstreamer-1.0 gstreamer-app-1.0 gstreamer-audio-1.0
gst-inspect-1.0 rtpopusdepay
node --version
bazel version
```

Then build and test the server:

```bash
bazel build //server:server
bazel test //server:chat_db_test
```

### Troubleshooting

- **`Package gstreamer-app-1.0 was not found`** — install the GStreamer
  development packages for your platform, then rerun
  `pkg-config --modversion gstreamer-app-1.0`.
- **`Failed to find element factory ... 'rtpopusdepay'`** — install the
  GStreamer base/good plugins (`gstreamer1.0-plugins-good` on Linux,
  `gst-plugins-good` on macOS).
- **`node: not found` while running Bazel** — `script/workspace_status.ts` runs
  outside Bazel's sandbox, so Node must be on your `PATH`. Install the version
  from `.tool-versions`.
- **Custom Homebrew prefix** — add its `lib/pkgconfig` and `share/pkgconfig`
  paths to `build:macos --action_env=PKG_CONFIG_PATH` in `.bazelrc`.

Docker builds do not need the local GStreamer packages; the builder stage
installs them inside the image.

## Bazel static build

### Format code

Run this command to fix code style (JS/TS/CSS, Rust, Starlark):

```bash
bazel run //tools/format:format
```

Check formatting without modifying files:

```bash
bazel test //tools/format:format_test
```

### Build static

```bash
bazel build //assets/css
```

### Code generation

The chat WebSocket protocol is defined in `contracts/chat/chat.proto`. After editing the `.proto` file, regenerate both the Rust and TypeScript outputs.

**Rust** (via `prost`, runs automatically as part of the server build):

```bash
bazel build //contracts/chat:chat_rs
```

**TypeScript** (Bazel build outputs):

```bash
bazel build //assets/js:styles_ts //assets/js:chat_ts
```

For editor-only copies of those generated files in `assets/js/gen/`, run:

```bash
npm run gen
```

### Run Bazel tests

Run all tests:

```bash
bazel test //...
```

Run all frontend tests (any `*.test.ts` under `assets/js/`):

```bash
bazel test //assets/js:all
```

Run a specific frontend test:

```bash
bazel test //assets/js:chat/protocol.test
bazel test //assets/js:chat/attachments-proto.test
```

Run all suites (builds server automatically):

```bash
./tests/e2e/run.sh
```

Run a specific suite:

```bash
./tests/e2e/run.sh suites/chat
./tests/e2e/run.sh suites/attachments.test
```

Or directly via npm (server must already be built):

```bash
cd tests/e2e && npm ci && npx jest
```



### Run rust server

This command will run a http server on port 8080

```bash
bazel run //server:server
```

### Build docker container

```bash
npm run build
npm run save
```

### Run docker container

```bash
npm start
```

## Development with PM2

Start server with auto-reload on source changes:

```bash
pm2 start ecosystem.config.cjs
```

Watch logs:

```bash
pm2 logs server --nostream
```

Restart (rebuilds assets):

```bash
pm2 restart server
```

Stop:

```bash
pm2 stop server
pm2 delete server
```

The server auto-rebuilds when files in `assets/` change.
