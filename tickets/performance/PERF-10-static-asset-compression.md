---
title: "Build and Serve Precompressed Static Assets"
ticket: "PERF-10"
status: "planned"
draft: false
weight: 10
---

# PERF-10 Build and Serve Precompressed Static Assets

**Priority: P2. Independent performance improvement.**

## Depends on

- Existing esbuild → Closure ADVANCED bundle and PostCSS build pipeline.

Detailed specification: [assets/compression.md](../../assets/compression.md).
That document remains the source of the build, serving, and verification requirements.

## Goal

Compress static JavaScript and CSS once during the build, and serve the negotiated representation
without recompressing it on each request.

## Baseline

The source plan records these measurements for deployed `0119811` on 2026-10-26:

| Chat bundle representation | Bytes |
| --- | ---: |
| Uncompressed | 24,295 |
| Production Brotli response | 9,371 |
| Build-time Brotli Q11 benchmark | 7,996 |

The measured saving was 1,375 bytes (14.7%) against runtime Brotli.
Remeasure the implementation candidate; these are historical payload sizes, not a guaranteed saving.

## Scope

- Add a pinned Bazel Node tool using `node:zlib`: Brotli Q11 text mode and deterministic gzip level 9.
- Compress final optimized browser bundles, static `mc.js`, and generated CSS; retain the originals.
- Declare compression actions and outputs in Bazel. Use a separate output tree for CSS compression.
- Package variants alongside originals in runfiles and the Linux image through the normal server build.
- Negotiate `Accept-Encoding` with quality values, wildcards, explicit exclusions, and identity fallback.
- Preserve MIME types, set `Content-Encoding` and `Vary: Accept-Encoding`, and prevent double compression.
- Support representation-aware validators, `304`, `HEAD`, and a documented range-request policy.
- Preserve static-root containment, including encoded paths and symlink handling.
- Keep runtime compression for dynamic responses and avoid recompressing already-compressed media/fonts.
- Keep existing asset URLs; immutable caching for unversioned URLs is outside this ticket.

## Implementation Areas

- `tools/compression/` (new) and `tools/closure/defs.bzl`
- `assets/js/BUILD.bazel` and `assets/css/BUILD.bazel`
- `server/BUILD.bazel`, `server/src/main.rs`, and `Dockerfile`

## Tests and Acceptance

- [ ] Decompressing either variant reproduces the exact original bytes; repeated builds are deterministic.
- [ ] Negotiation tests cover Brotli, gzip, identity, absent/wildcard headers, quality ordering, and rejected encodings.
- [ ] Missing variants fall back only to acceptable representations; otherwise return `406`.
- [ ] MIME type, encoding, `Vary`, lengths, conditional requests, `HEAD`, and ranges match the serving contract.
- [ ] Tests verify path containment and that precompressed bytes are not compressed twice.
- [ ] A raw Brotli response equals the generated `.br` artifact byte-for-byte.
- [ ] Normal Bazel and Docker builds package the assets without an extra deployment step.
- [ ] Browser smoke tests pass and measurements report candidate commit, artifact sizes, and transferred bytes.
- [ ] After a later deployment, verify negotiation through the public reverse proxy as specified in the source plan.
