# Convex Auth v2

This branch contains a WIP implementation of Convex Auth v2.

## Getting Started

Use `pnpm install` at the root.

The `@convex-dev/argon2id` package depends on some Rust code compiled to WebAssembly.
Its `prepare` script builds it automatically on `pnpm install` when the compiled
output is missing, so you'll need [`just`](https://github.com/casey/just) and the
toolchain pinned in `packages/argon2id/src/argon2-wasm/rust-toolchain.toml` (installed
automatically by `rustup` on first use).

To rebuild the WASM after changing the Rust source, run:

```bash
pnpm --filter @convex-dev/argon2id build:wasm
```

Common tasks:

- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm lint` — ESLint.
- `pnpm format` — Prettier.

## Examples

The `examples/` directory holds in-repo example apps. Each is a self-contained
Convex backend that mounts the auth components, and is run from its own
directory (see the example's own README):

- `examples/react-minimal` — the core component with the anonymous provider.
- `examples/react-password` — the core component with the password provider.

Their tests run as part of `pnpm test` at the repo root.
