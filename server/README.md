## Run

Server will start on localhost and will use 8080 port

```bash
cargo run
```

## Tests

All Rust tests run via Bazel (not `cargo test` — the binary requires `BAZEL_STATIC` baked in at compile time):

```bash
bazel test //server:chat_db_test
```

To see full test output:

```bash
bazel test //server:chat_db_test --test_output=all
```

All WS tests send binary protobuf frames (`ClientFrame`/`ServerFrame`) — there is no JSON on the wire.

## Prettier

```bash
cargo fmt
```

## Proto code generation

Protobuf contracts live in `../contracts/`. The server uses two build systems
that each generate Rust code from the same `.proto` files:

| Tool | How | Output |
|---|---|---|
| `cargo build` | `build.rs` + `prost-build` | `src/generated/*.rs` |
| `bazel build` | `rust_prost_library` | `bazel-bin/contracts/assets/` |

### Why `src/generated/` is committed to git

`cargo build` writes generated files to `src/generated/` — inside the source
tree, not `target/`. This is intentional: rust-analyzer reads source files
directly and does not execute `build.rs`, so without the committed files it
cannot resolve `crate::generated::*` and all type information is lost in the
editor.

The trade-off:

- **Pro** — editor works out of the box, no build step required to get types
- **Con** — when a `.proto` changes you must re-run `cargo build` and commit
  the updated `src/generated/*.rs` alongside the `.proto` change

If you change a `.proto` file, regenerate with:

```bash
cargo build
git add src/generated/
```

### Why not gitignore `src/generated/`?

Gitignoring it would break rust-analyzer for every developer who hasn't run
`cargo build` yet. The generated files are deterministic (same proto → same
output) so committing them does not introduce noise — only a proto change
produces a diff.

