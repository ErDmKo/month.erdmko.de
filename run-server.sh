#!/bin/bash

rebuild_and_run() {
  bazel build //assets/js:month-bundle
  bazel run //server:server
}

rebuild_and_run
