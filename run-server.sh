#!/bin/bash

unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE

rebuild_and_run() {
  bazel build //assets/js:month-bundle
  bazel run //server:server
}

rebuild_and_run
