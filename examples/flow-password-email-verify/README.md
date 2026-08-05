# flow-password-email-verify

**Use case**: email + password sign-up where **no user document exists until
the email is verified**. Evaluation fixture — server bodies are
`TODO(auth-v2)` stubs. See `../FLOWS.md` for conventions.

## The flow

1. `/signup`: user enters email + password → `auth.signUp` → the server
   validates the password, stores the hash **against the flow, not a user**,
   emails a 6-digit code, returns `{ status: "needs", step: "verify-email",
   flowId }`.
2. Code-entry screen (survives reload via the persisted `flowId`) →
   `auth.verifyEmail` → **only now** is the `users` row created (with a
   verified email from birth) → `{ status: "complete", tokens }` → client
   calls `setSession(tokens)`.
3. `/login`: `auth.signIn` → `complete`, or `needs: "verify-email"` for
   never-verified accounts (reusing the same code-entry UI), or
   `INVALID_CREDENTIALS`.

## Acceptance criteria

- At no point before `verifyEmail` succeeds does a `users` row (or any
  user-visible record) exist for the pending email.
- Abandoning sign-up after step 1 leaves nothing behind that blocks the same
  email from signing up later (flow state expires).
- Signing up with an email that already has a verified account returns the
  *same* pending shape as a fresh sign-up (enumeration resistance) and
  notifies the existing account's inbox instead.
- Codes are single-use, expire, and allow limited attempts (`CODE_INVALID`
  carries `detail.attemptsRemaining`).
- Wrong email and wrong password produce the identical `INVALID_CREDENTIALS`
  error.
- Reloading during code entry resumes the same flow.
- `users.email` is the only field the app schema needs; auth dictates nothing.

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until the
stubs are implemented, every auth call throws its TODO.
