# WhatAmonth

My homepage app

## Deploy command sequence

Requires Docker, Node.js `24.14.1` (pinned in `.tool-versions`), Bazel, and
SSH access to the Ansible inventory host.

The container image builds `//server:server` with Bazel inside a Linux Docker
builder. This packages the Bazel binary and its runfiles, including frontend
assets, templates, generated protocol code, and the GStreamer runtime needed
for voice calls.

```bash
npm run build
npm run save
ansible-playbook ansible/push.yaml -i ansible/inventory.yaml
```

Or just

```bash
npm run pub
```

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
