# flow-oauth-link

**Use case**: "Continue with Google/GitHub" sign-in with **safe account
linking** — auto-link only when the OAuth email is verified on both sides,
confirmed linking (prove the existing password account first) when trust is
insufficient. Evaluation fixture — server bodies are `TODO(auth-v2)` stubs.
See `../FLOWS.md` for conventions.

## The flow

1. `/login`: "Continue with Google/GitHub" → `auth.startOAuth({ provider,
   redirectTo })` → the server allowlists `redirectTo`, stores hashed-state +
   PKCE handshake state keyed to a new flow, and returns the provider
   authorization URL → the client navigates to it.
2. The provider redirects to an **auth HTTP route** (not app code), which
   validates state, exchanges the code (provider tokens never reach the
   client), records the provider profile against the flow, and 302s back to
   `redirectTo` with `?flow=<flowId>&outcome=...`.
3. `/callback` calls `auth.completeOAuth({ flowId })` exactly once (StrictMode
   guard — the flow ticket is one-time). The server resolves the
   (provider, subject) identity:
   - known identity → `{ status: "complete", tokens }`;
   - unknown identity, provider-verified email matching an account whose
     email is **also** verified → auto-link → `complete`;
   - unknown identity, email matching an account without sufficient trust →
     `{ status: "needs", step: "confirm-link", flowId, detail:
     { maskedEmail, methods } }` — nothing linked yet;
   - no match → create the user from the provider profile → `complete`.
4. On `confirm-link` the client shows a password form for the masked email →
   `auth.confirmLinkWithPassword({ flowId, password })` → only after the
   password verifies is the OAuth identity linked → `complete` →
   `setSession(tokens)`.

## Acceptance criteria

- Auto-link happens **only** when the email is verified on both sides
  (provider assertion AND existing account); anything less takes the
  `confirm-link` path.
- The `confirm-link` path links **nothing** until the password check passes;
  abandoning it leaves both accounts untouched.
- The callback is resumable/idempotent-safe: `completeOAuth` redeems a
  one-time ticket, so a double invoke on the same `flowId` gets
  `FLOW_EXPIRED` on the second call — the client guards against StrictMode
  double-effects and tolerates the error if it happens anyway.
- No client-supplied intent parameter exists anywhere: link-vs-sign-in is
  derived server-side from session/account state and cannot be forged.
- The client never sees provider access/refresh tokens; the code exchange
  happens inside the auth HTTP route.
- `redirectTo` is validated against an allowlist of app origins; the OAuth
  `state` is stored hashed and PKCE is used.
- Wrong password on confirm-link → `INVALID_CREDENTIALS`, rate limited.

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until the
stubs are implemented, every auth call throws its TODO.
