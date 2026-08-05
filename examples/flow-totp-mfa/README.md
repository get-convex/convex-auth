# flow-totp-mfa

**Use case**: password sign-in that **dynamically requires a TOTP second
factor** when the account has one enrolled; plus enrollment with a QR
secret + one-time backup codes, and backup-code sign-in. Evaluation
fixture — server bodies are `TODO(auth-v2)` stubs. See `../FLOWS.md` for
conventions.

## The flow

1. `/login`: email + password → `auth.signIn` → for an account without
   TOTP, `{ status: "complete", tokens }`; for an account with TOTP,
   `{ status: "needs", step: "totp", flowId }` — the verified password is
   parked on the flow and **no session exists yet**. The decision is
   per-account and server-side; the client learns it only from the union.
2. Code-entry screen (survives reload via the persisted `flowId`) →
   `auth.verifyTotp`, or — behind a "Use a backup code instead" toggle —
   `auth.useBackupCode` with the same `flowId`. Either success creates the
   session (AAL2) → `{ status: "complete", tokens }` → `setSession(tokens)`.
3. `/` dashboard: if 2FA is off, "Enable two-factor auth" →
   `auth.startTotpEnrollment` (requires recent re-auth) → the client shows
   the `otpauthUrl` + secret (a real UI would render a QR) → a live code →
   `auth.confirmTotpEnrollment` → backup codes rendered **exactly once**.
   If 2FA is on, "Disable 2FA" → `auth.disableTotp`.

## Acceptance criteria

- No session exists between password success and TOTP success — abandoning
  at the challenge leaves the user signed out.
- Whether the second factor is required is decided server-side per account;
  the client contains no per-account logic.
- An enrollment secret is inert until a live code confirms it; an abandoned
  enrollment never affects sign-in.
- Backup codes are single-use, hashed at rest, and displayed exactly once
  (at confirmation time).
- TOTP codes are replay-protected: a consumed code is never accepted again,
  and attempts per flow are limited (`FLOW_EXPIRED` after too many).
- The challenge phase survives a page reload (persisted `flowId` resumes
  the same flow).
- `startTotpEnrollment` / `disableTotp` demand recent re-auth
  (`REAUTH_REQUIRED`; the full step-up UX lives in `flow-step-up`).

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until
the stubs are implemented, every auth call throws its TODO.
