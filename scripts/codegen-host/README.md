# Codegen host

An empty Convex app that exists only so that `pnpm codegen` has a deployment to
generate the component code against.

It is a workspace package, thus `pnpm install` links the `convex` that it
declares. `scripts/codegen.ts` finds it like any other app and leaves it out of
the app list, because it generates no code of its own.
