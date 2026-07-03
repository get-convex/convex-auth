This is Convex Auth, an authentication framework built on top of Convex. We’re currently bulding the v2 version of the system, where individual auth providers are implemented as Convex components.

## Repository layout

This is a pnpm monorepo:

- `packages/core` — the core auth component, published as `@convex-dev/auth`. Owns sessions, accounts, and JWT minting; it is provider-agnostic.
- `examples/react-minimal` — a minimal example app wiring up the core component.

Use `pnpm install` at the root. Common tasks:

- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm lint` — ESLint, including the Convex ESLint plugin.
- `pnpm format` — Prettier.
