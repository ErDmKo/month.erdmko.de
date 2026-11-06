# Build-Time Static Asset Compression

**Status: planned, not implemented.** This is independent of the routing and hydration work in [SSR.md](SSR.md).

Tracked by [PERF-10: Build and Serve Precompressed Static Assets](../tickets/performance/PERF-10-static-asset-compression.md).

## Motivation

The server currently uses `middleware::Compress::default()` and `actix_files::Files` in [`server/src/main.rs`](../server/src/main.rs). Static assets are compressed at request time rather than served from precompressed build outputs.

Measurements for the deployed `0119811` release on 2026-10-26:

| Chat bundle representation                 |  Bytes |
| ------------------------------------------ | -----: |
| Uncompressed JavaScript                    | 24,295 |
| Production Brotli response body            |  9,371 |
| Build-time Brotli Q11 benchmark, text mode |  7,996 |

Serving the Q11 artifact would save approximately **1,375 bytes per chat-bundle download (14.7%)** compared with the measured production response. These are payload sizes, excluding HTTP headers and TLS overhead. Future source changes or compressor versions may change the exact numbers.

The goal is to pay the high-quality compression CPU cost once during the build, not on every request.

## Initial Scope

- Precompress the five optimized browser bundles and the static `mc.js` script.
- Precompress generated CSS.
- Keep the original files alongside Brotli and gzip variants.
- Preserve existing asset URLs; clients still request `/static/js/chat-bundle.js`, not a `.br` URL.
- Keep runtime compression for dynamic pages and API responses.
- Leave already-compressed formats such as PNG, JPEG, WebP, and WOFF2 alone.
- Consider other static text formats, such as SVG and JSON, in a later extension.

Tera templates are inputs to dynamic rendering, not static HTML response bodies, and should not be precompressed as part of this step.

## Build Pipeline

```text
TypeScript -> esbuild -> Closure ADVANCED -> final.js
                                              |-> final.js.br  (Brotli Q11)
                                              |-> final.js.gz  (gzip level 9)

CSS -> PostCSS/cssnano -> style.css
                            |-> style.css.br
                            |-> style.css.gz
```

Compression must run **after** minification and optimization, against the exact bytes that would otherwise be served.

### Compression Tool

Add a small tool under `tools/compression/` using Node's built-in `node:zlib`:

- Brotli quality `11` and text mode, matching the benchmark settings.
- gzip level `9`, with deterministic headers and no varying timestamps or original filenames.
- Binary-safe file input/output; do not rewrite whitespace, newlines, or character encoding.
- Use a pinned Bazel Node toolchain rather than an arbitrary host `node` or system compression executable.
- No additional npm compression dependency is required.

The original, `.br`, and `.gz` files must all decode to the same content. Do not replace an original asset with compressed bytes under its original filename.

### Bazel Integration

- Extend [`tools/closure/defs.bzl`](../tools/closure/defs.bzl) with compression actions that depend on the final optimized bundle targets.
- Preserve existing raw bundle target names and filenames; expose additional targets or filegroups for the compressed variants.
- Declare all inputs, outputs, and tools so Bazel can cache compression and invalidate it when asset content, compressor code, settings, or toolchain versions change.
- Add equivalent handling for the static script and generated CSS in [`assets/js/BUILD.bazel`](js/BUILD.bazel) and [`assets/css/BUILD.bazel`](css/BUILD.bazel).
- Do not add a separate manual deployment command: `bazel build //server:server` should build the required compressed assets through its dependency graph.

**CSS output layout:** the current PostCSS rule declares the entire `minified` directory as an output tree. A separate rule must not write additional files inside that same declared tree. Use a separate declared output tree or an explicit staging/extraction target, then assemble the original and compressed files into the final static asset layout.

### Runfiles and Docker Packaging

- Include compressed assets in the `data` dependencies of [`server/BUILD.bazel`](../server/BUILD.bazel).
- Ensure both local Bazel runfiles and the release image contain the variants next to their original assets.
- Update the asset assembly in [`Dockerfile`](../Dockerfile) where needed, especially for the CSS output tree.
- Never generate compressed files inside source directories as an undeclared build side effect.

The deployed layout should include, for example:

```text
/app/assets/js/chat-bundle.js
/app/assets/js/chat-bundle.js.br
/app/assets/js/chat-bundle.js.gz
/app/assets/css/minified/style.css
/app/assets/css/minified/style.css.br
/app/assets/css/minified/style.css.gz
```

## HTTP Serving Contract

Adding `.br` and `.gz` files alone is insufficient: the current static handler does not select those siblings automatically. Add encoding-aware static-file serving in [`server/src/main.rs`](../server/src/main.rs).

1. Negotiate an available representation using `Accept-Encoding`, respecting quality values, explicit exclusions such as `br;q=0`, wildcards, and identity rules. Prefer Brotli over gzip when both are equally acceptable.
2. Serve the corresponding file without recompressing it. Actix's [`NamedFile::set_content_encoding`](https://docs.rs/actix-files/0.6.6/actix_files/struct.NamedFile.html#method.set_content_encoding) supports precompressed responses and prevents the `Compress` middleware from modifying their contents.
3. Preserve the original asset's MIME type and inline disposition. Do not infer the MIME type solely from the `.br` or `.gz` suffix; `NamedFile::from_file` can associate the opened compressed file with the logical original path.
4. Set `Vary: Accept-Encoding`, preserving any other existing `Vary` values.
5. Fall back only to an available, acceptable representation. Do not silently send identity when the client excludes it; return `406 Not Acceptable` if no acceptable representation can be served.
6. Preserve conditional requests and use representation-appropriate cache validators. An ETag for one encoding must not incorrectly validate a different representation.
7. Support `HEAD` without a response body and with metadata for the selected representation.
8. Define and test range-request behavior. A conservative first version can use the original representation for range requests when identity is acceptable; do not violate encoding negotiation or return misleading `Content-Range` metadata.
9. Preserve the existing static-root containment and path traversal protections, including encoded paths and symlink handling.

Do not introduce long-lived `immutable` caching for the current unversioned bundle URLs as part of this change. Content-hashed filenames and cache-policy changes are a separate concern.

## Validation and Acceptance Criteria

- Tool tests verify that Brotli and gzip outputs decompress byte-for-byte to the original input and repeated builds produce identical compressed bytes.
- Server tests cover Brotli, gzip, identity, quality preferences, explicit exclusions, wildcards, missing variants, and requests with no `Accept-Encoding` header.
- Header tests cover MIME type, `Content-Encoding`, `Vary`, selected-representation lengths, ETags, `304`, and `HEAD` behavior.
- Security and range tests verify that the new handler does not weaken existing file-serving safeguards.
- Existing browser tests continue to exercise the shipped optimized bundles successfully.
- The Linux release image is checked for all required original and compressed assets before deployment.
- A real HTTP request with `Accept-Encoding: br` returns the **exact generated `.br` bytes**, not just any Brotli stream that decodes to the original.
- Measure raw response bodies without automatic client decompression. Report built artifact sizes and actual transferred payload sizes separately.
- Recheck the public HTTPS endpoint after deployment, since the reverse proxy may affect encoding negotiation, caching, or compression.

This is a focused build-and-serving change, not a rewrite of the frontend bundles or SSR architecture.
