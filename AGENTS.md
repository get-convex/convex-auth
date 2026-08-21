This is Convex Auth, an authentication framework built on top of Convex. We’re currently bulding the v2 version of the system, where individual auth providers are implemented as Convex components.

## Repository layout

This is a pnpm monorepo:

- `packages/core` — the auth package, published as `@convex-dev/auth`. Owns sessions, accounts, and JWT minting (the provider-agnostic core), plus the bundled providers: the anonymous provider and the password provider (which stores and verifies passwords keyed by an opaque user id). It also owns the username component, a non-provider component that maps a username onto an opaque user id.
- `packages/argon2id-wasm` — the `argon2id-wasm` package wrapping the argon2id WASM hasher used by the password provider. It publishes compiled JavaScript plus declarations from `dist/`, so consumers never typecheck its source. Its `prepack` script builds the Rust/WASM output and then compiles the TypeScript wrapper, which keeps the Rust toolchain a publish-time requirement — `pnpm install` and TypeScript-only work don't need it. `packages/core` depends on the published package, not the workspace one, for the same reason.
- `examples/` — example apps, each an in-repo Convex backend run from its own
  directory:
  - `react-minimal` wires up the core with the anonymous provider.
  - `react-password` wires up the core with the password provider.
  - `react-email-password` wires up the core, password, and email components
    with the `EmailPassword` provider (sign-up with email validation, change
    password/email, password recovery; email through `@convex-dev/resend`).

## Published output

`@convex-dev/auth` ships **compiled** ESM plus declarations under `dist/`; its
`exports` map points there, never at `src/` (`argon2id-wasm` does the same). This matters:
a package whose `exports` resolve to `.ts` gets typechecked by the consumer's
`tsconfig.json`, so our source would have to satisfy _their_ `lib`, `types`,
and `verbatimModuleSyntax` settings. Two rules follow from it:

- Relative imports in `packages/core/src` carry the extension of the file on
  disk (`./cookies.ts`, `./client.tsx`). `packages/core/tsconfig.json` sets
  `moduleResolution: NodeNext`, so an import without an extension is a compile
  error (TS2835) in the editor and in `tsc --noEmit`, and
  `rewriteRelativeImportExtensions` turns each one into `.js` in the emitted
  JavaScript, which is what Node's ESM resolver needs. Declarations keep the
  `.ts` specifier; a consumer's TypeScript reads that as the sibling `.d.ts`,
  back to TypeScript 5.0. Files under `_generated/` keep the `.js` extensions
  that `convex codegen` writes, and both spellings compile. The examples and
  docs are free to stay extensionless.
- Anything reached from a published entry point must compile. `dist/` is built
  by `tsconfig.build.json`, which excludes tests and other in-repo-only
  modules (see its `exclude` list).

The one exception is `./providers/testing/*`, which ships as TypeScript from
`src/`. Those helpers call `import.meta.glob`, a Vite macro that has to be
transformed by the consumer's bundler — and Vitest externalizes plain `.js`
under `node_modules` (leaving the macro intact, so it throws at import) while it
cannot externalize `.ts`. Shipping source is what makes them work. They carry
their own `/// <reference types="vite/client" />` so a consumer doesn't need
`vite/client` in their `tsconfig`. Their schema import is also the one place
that keeps a `.js` extension: the consumer's `tsc` reads these files, and a
`.ts` extension there is an error (TS5097) unless they turn on
`allowImportingTsExtensions`. The example apps' `pnpm typecheck` catches a
regression here.

Use `pnpm install` at the root. Common tasks:

- `pnpm build` — compile `packages/core` to `dist/`. Runs automatically via
  `prepare` on install; run it by hand after changing its sources if you want
  the examples to pick the change up. (`argon2id-wasm` is consumed from npm,
  so it isn't built here — see its `prepack`.)
- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm lint` — ESLint, including the Convex ESLint plugin.
- `pnpm format` — Prettier.
