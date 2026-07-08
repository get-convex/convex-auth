# Convex Auth v2

This branch contains a WIP implementation of Convex Auth v2.

## Getting Started

Use `pnpm install` at the root.

The `passwordProvider` component depends on some Rust code. In order to build the repository from source, you will need to run:

```bash
cd packages/core/src/components/passwordProvider/argon2-wasm/ && just build
```

TODO(nicolas) Make the Rust build automatic

Common tasks:

- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm lint` — ESLint.
- `pnpm format` — Prettier.
