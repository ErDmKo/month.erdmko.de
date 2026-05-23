#!/usr/bin/env bash
# run.sh — build server and run e2e tests
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "[e2e] Building server binary..."
cargo build --bin server

echo "[e2e] Installing test dependencies..."
cd tests/e2e
npm ci

echo "[e2e] Running e2e tests..."
npx jest "$@"
