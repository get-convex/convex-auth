# flow-email-otp

**Use case**: passwordless sign-in — enter your email, enter the 6-digit code
it emailed you. **The user document is created on the first successful
verification**; returning users resolve to their existing row. Evaluation
fixture — server bodies are `TODO(auth-v2)` stubs. See `../FLOWS.md` for
conventions.

## The flow

1. `/login`: user enters their email → `auth.requestCode` → the server
   generates a hashed, single-use, short-lived code, emails it, and returns
   `{ flowId, resendAfterMs }` — the **same shape whether or not the email
   has an account** (enumeration resistance). Rate limits surface as a thrown
   `ConvexError` with code `RATE_LIMITED`.
2. Code-entry screen (survives reload via the persisted `flowId`) →
   `auth.verifyCode` → on success, an existing account for the verified email
   is resolved, **or the `users` row is created right now** (with a verified
   email from birth) → `{ status: "complete", tokens }` → client calls
   `setSession(tokens)`.
3. "Resend code" calls `auth.requestCode` again with the same email: the code
   rotates but the `flowId` stays the same, so the open code-entry screen
   keeps working.

## Acceptance criteria

- New and returning emails get the **identical UX** — same return shapes,
  same steps; the client cannot tell whether an account existed (no
  user-existence leak).
- A `users` row is created only on the first successful `verifyCode`; a
  returning email resolves to its existing row instead of creating another.
- Requesting a code never reveals account existence and is rate limited per
  email and per caller (`RATE_LIMITED` via thrown `ConvexError`).
- Codes are hashed at rest, single-use, expire quickly, and allow limited
  attempts (`CODE_INVALID` messages include attempts remaining; exhaustion
  kills the flow). Stale flows return `FLOW_EXPIRED`.
- Resending keeps the same `flowId`.
- Reloading during code entry resumes the same flow.
- `users.email` is the only field the app schema needs; auth dictates nothing.

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until the
stubs are implemented, every auth call throws its TODO.
