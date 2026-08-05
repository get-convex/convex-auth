# flow-settings-security

**Use case**: an account-security settings page for a signed-in user — linked
identities (link/unlink), active sessions (revoke, sign out everywhere else),
and passkeys (add/rename/remove). Evaluation fixture — server bodies are
`TODO(auth-v2)` stubs. See `../FLOWS.md` for conventions.

This fixture assumes an existing session: any sign-in fixture (e.g.
`flow-password-email-verify`) can front it, so there are no sign-in
functions here. The code is split: `convex/auth.ts` holds only the standard
`refreshSession`/`signOut` plumbing; the whole security surface lives in
`convex/security.ts`.

## The flow

1. `/` renders three sections off three **reactive** queries —
   `security.listIdentities`, `security.listSessions`,
   `security.listPasskeys` — with loading and empty states. A change from
   another tab (or a revocation) appears live, no polling.
2. **Identities**: "Link Google/GitHub" → `security.startLinkOAuth`, which
   **throws** `ConvexError { code: "REAUTH_REQUIRED" }` when the session's
   last verification is older than the policy window; the client opens an
   inline "Confirm it's you" form → `security.reauthWithPassword` → retries
   the original call. Link-intent is derived from the authenticated session
   (no intent parameter). The OAuth return lands on `/callback`; completing
   the link is handled by the auth HTTP route and is out of scope here (see
   `flow-oauth-link` for the full callback treatment).
3. **Unlink** → `security.unlinkIdentity` → `{ ok: true }` or `{ ok: false,
   code: "LAST_CREDENTIAL" | "REAUTH_REQUIRED", message }` (error returns,
   not throws — this surface keeps the union). The client disables the
   button for the last credential; the server refusal is the real guarantee.
4. **Sessions**: a "current" badge, per-row `security.revokeSession`
   (revocation propagates to that device's live WebSocket immediately), and
   `security.revokeOtherSessions`, which reports the revoked count.
5. **Passkeys**: `security.addPasskey` (the WebAuthn challenge/attestation
   round trip is collapsed into one call in this fixture; the real API needs
   a begin/finish pair or a client helper hook), inline
   `security.renamePasskey`, and `security.removePasskey` (same
   last-credential rule as unlink).
6. `security.reauthWithPassword` refreshes the **current** session's
   verification timestamp — no new session, no new tokens, no reconnect.

## Acceptance criteria

- Every list is reactive: a revoke or unlink from another tab disappears
  from this page live, with no refetch or polling.
- Unlinking/removing the **last** credential is structurally refused
  server-side (`LAST_CREDENTIAL`) — locking yourself out is impossible even
  if the client misbehaves; the disabled button is UX only.
- Sensitive operations (link, unlink, add/remove passkey) are
  step-up-gated: stale verification yields `REAUTH_REQUIRED` (thrown by
  `startLinkOAuth`, returned in the union by the mutations), and the client
  recovers by re-proving and retrying.
- `reauthWithPassword` refreshes verification freshness **without**
  replacing the session or reconnecting the WebSocket.
- Revoking a session signs that device out immediately (reactive push, not
  next-request detection).
- Every query and mutation requires authentication and scopes strictly to
  the current user.

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until the
stubs are implemented, every auth call throws its TODO.
