# flow-step-up

**Use case**: a signed-in dashboard where sensitive operations require
**recent** re-authentication ("prove it's still you") — without signing
out, without replacing the session, without the WebSocket ever blinking.
Evaluation fixture — server bodies are `TODO(auth-v2)` stubs. See
`../FLOWS.md` for conventions. Sign-in itself is out of scope here (see
the other `flow-*` fixtures); the page renders as if authenticated.

## The flow

1. `/`: the dashboard shows a freshness indicator driven by
   `auth.authFreshness` (reactive): "Session verified — sensitive actions
   unlocked for MM:SS" counting down, vs. "Sensitive actions will ask you
   to confirm your password." Advisory UX only — the guards are
   server-side.
2. "Reveal API secret" → `account.revealApiSecret`. Its handler opens with
   a one-liner guard (`await requireRecentAuth(ctx, { within: 5 * 60_000 })`)
   that throws `ConvexError({ code: "REAUTH_REQUIRED", methods:
   ["password"], maxAgeMs })` when the session's last verification is too
   old.
3. The shared `useStepUp` helper catches exactly that error, opens a
   re-auth modal (password form) → `auth.reauthWithPassword` → on
   `{ ok: true, freshUntil }` it **automatically retries the original
   call** — the user never re-clicks. Re-auth only bumps the current
   session's last-verified timestamp: same session, same tokens.
4. "Delete account" (type `DELETE` to confirm) → `account.deleteAccount`,
   whose guard demands a **tighter** window (1 minute) — different
   operations, different freshness policies, same mechanism.

## Acceptance criteria

- Re-auth NEVER creates a new session or interrupts the WebSocket; only
  the current session's last-verified timestamp changes.
- Guards are server-side; the client freshness display is advisory UX
  only and enforces nothing.
- Different operations can demand different windows (5 minutes for reveal,
  1 minute for delete).
- The thrown error carries which methods can satisfy the step-up
  (`methods: ["password"]`).
- After a successful re-auth, the original call is retried and succeeds
  without the user re-clicking the original button.
- `authFreshness` updates reactively after `reauthWithPassword`, so the
  countdown flips without polling.

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until
the stubs are implemented, every call throws its TODO.
