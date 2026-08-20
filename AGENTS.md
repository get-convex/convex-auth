This is Convex Auth, an authentication framework built on top of Convex. We’re currently bulding the v2 version of the system, where individual auth providers are implemented as Convex components.

## Repository layout

This is a pnpm monorepo:

- `packages/core` — the auth package, published as `@convex-dev/auth`. Owns sessions, accounts, and JWT minting (the provider-agnostic core), plus the bundled providers: the anonymous provider and the password provider (which stores and verifies passwords keyed by an opaque user id). It also owns the username component, a non-provider component that maps a username onto an opaque user id.
- `packages/argon2id-wasm` — the `argon2id-wasm` package wrapping the argon2id WASM hasher used by the password provider. It publishes compiled JavaScript plus declarations from `dist/`, so consumers never typecheck its source. Its `prepack` script builds the Rust/WASM output and then compiles the TypeScript wrapper, which keeps the Rust toolchain a publish-time requirement — `pnpm install` and TypeScript-only work don't need it. `packages/core` depends on the published package, not the workspace one, for the same reason.
- `examples/` — example apps, each an in-repo Convex backend run from its own
  directory:
  - `react-minimal` wires up the core with the anonymous provider.
  - `react-password` wires up the core with the password provider.

Use `pnpm install` at the root. Common tasks:

- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm lint` — ESLint, including the Convex ESLint plugin.
- `pnpm format` — Prettier.
