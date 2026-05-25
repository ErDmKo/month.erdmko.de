#!/usr/bin/env bash
# run.sh — build server and run e2e tests
#
# Usage:
#   ./tests/e2e/run.sh                  # all suites
#   ./tests/e2e/run.sh suites/chat      # specific suite
#   ./tests/e2e/run.sh --testNamePattern "upload"
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "[e2e] Building server with Bazel..."
bazel build //server:server

echo "[e2e] Installing test dependencies..."
cd tests/e2e
npm ci

echo "[e2e] Running e2e tests..."
npx jest "$@"
