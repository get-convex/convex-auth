# flow-anonymous-upgrade

**Use case**: guest-first app. Visitors are signed in anonymously on first
load and can immediately create real data (a tiny todo list). "Create
account" upgrades the guest to email+password **keeping the same userId and
all of their data**. Evaluation fixture — auth bodies are `TODO(auth-v2)`
stubs (`todos.ts` is real, working app code). See `../FLOWS.md` for
conventions.

## The flow

1. `/`: an unauthenticated visitor triggers `auth.signInAnonymously` from a
   `useEffect` (no button, no form) → the server creates a real `users` row
   (`isAnonymous: true`) and a real session → `{ status: "complete",
   tokens }` → `setSession(tokens)`. The visitor adds todos; they persist
   across reloads like any user's data.
2. A banner ("You're browsing as a guest — create an account to keep your
   work") links to `/upgrade`: email + password → `auth.upgradeAccount` →
   the server verifies the caller is an anonymous user, validates the
   password, attaches the credential to the **same** user, flips
   `isAnonymous` to false, and returns `{ status: "complete", tokens }` with
   **new tokens for the same userId**. The client swaps sessions and lands
   back on `/` — same todos.
3. Upgrading with an email that already has an account returns
   `{ status: "error", code: "LINK_CONFLICT" }`: merging two users' data is
   app-defined and out of scope for this fixture (a real app might offer the
   confirmed-linking flow instead — see `flow-oauth-link`).

Email verification is intentionally skipped in this fixture; a stricter
variant would return `needs: "verify-email"` from `upgradeAccount` (see
`flow-password-email-verify`).

## Acceptance criteria

- A guest gets a **real** user + session: todos are ordinary rows referencing
  `users`, and they survive page reloads.
- Auto sign-in fires exactly once per unauthenticated visitor (no duplicate
  guest users from StrictMode's double-invoked effects) and is rate limited
  per caller (`RATE_LIMITED`).
- Upgrading preserves the userId — manual test: note the user id shown on
  the dashboard before and after upgrading; it must not change, and every
  todo must still be there.
- `upgradeAccount` rejects unauthenticated and already-upgraded callers.
- Upgrading with an in-use email is a typed `LINK_CONFLICT`, never a silent
  merge or takeover.
- Anonymous users are distinguishable in app code (`isAnonymous` on the
  app-owned `users` table); auth dictates nothing else about the schema.

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until the
stubs are implemented, every auth call throws its TODO (todos would work —
but you can't sign in to reach them).
