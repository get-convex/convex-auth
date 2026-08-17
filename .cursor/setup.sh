#!/usr/bin/env bash
# Idempotent Cloud Agent setup for @convex-dev/auth.
# Mirrors the install steps used by CI (.github/workflows/{lint,test}.yml).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Install dependencies for the library and its example/test apps.
npm ci
(cd test && npm ci)
(cd test-nextjs && npm ci)
(cd test-router && npm ci)

# Build the library. The example apps link it via `file:..`, and the CLI
# bundle produced here is exercised by the tooling.
npm run build

# `just` drives the local Convex backend used by the Next.js e2e harness.
if ! command -v just >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
    | sudo bash -s -- --to /usr/local/bin
fi

# Playwright browsers (+ OS deps) for the Next.js end-to-end tests.
# Idempotent: skips already-installed browsers.
(cd test-nextjs && npx playwright install --with-deps)
