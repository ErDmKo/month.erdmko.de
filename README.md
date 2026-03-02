# WhatAmonth

My homepage app

## Deploy command sequence

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

### Pretter

Run this command to fix code style

```bash
bazel run //assets/js:prettier
```

### Build static

```bash
bazel build //assets/css
```

### Run rust server

This command will run a http server on port 8080

```bash
bazel run //server:server
```

#### Run code formater

Formatter for backend

```bash
cd server && cargo fmt
```

Formatter for frontend

```bash
bazel run //assets/js:prettier
```

### Run npm comands in bazel

```bash
 bazel run @nodejs_host//:npm -- version
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
