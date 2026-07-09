This is Convex Auth, an authentication framework built on top of Convex. We’re currently bulding the v2 version of the system, where individual auth providers are implemented as Convex components.

## Repository layout

This is a pnpm monorepo:

- `packages/core` — the core auth component, published as `@convex-dev/auth`. Owns sessions, accounts, and JWT minting; it is provider-agnostic.
- `packages/password` — the password provider component, published as `@convex-dev/auth-password`. Stores and verifies passwords keyed by an opaque user id.
- `packages/argon2id` — a private package (`@convex-dev/argon2id`) wrapping the argon2id WASM hasher used by the password provider. Its `prepare` script builds the Rust/WASM output when it's missing.
- `examples/` — example apps, each an in-repo Convex backend run from its own
  directory:
  - `react-minimal` wires up the core with the anonymous provider.
  - `react-password` wires up the core with the password provider.

Use `pnpm install` at the root. Common tasks:

- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm lint` — ESLint, including the Convex ESLint plugin.
- `pnpm format` — Prettier.
