# Flow examples — Convex Auth v2 evaluation fixtures

The `flow-*` examples are **not working apps**. Each one captures a single, real
login use case in code: real client UI driving an **aspirational server API**
whose function bodies are `TODO(auth-v2)` stubs. They exist to:

1. Give the v2 implementation a concrete target — every stub documents the
   behavior it must have, and the client code shows the DX we're aiming for.
2. Evaluate the eventual API: replace the stub bodies with real implementations
   and judge how clean the result looks.
3. Evaluate model/agent one-shot ability: hand an agent one example's README
   and stubs, ask it to implement the flow, and grade against the acceptance
   criteria in that README.

Each example is deliberately self-contained (one app per flow, duplication
over abstraction) so it can be evaluated — or one-shotted — in isolation. UI
is intentionally minimal: plain elements, shared `index.css`, no design system.

## Shared conventions

Every example follows the same contract, so implementations can be compared:

- **`convex/authTypes.ts`** (copied verbatim into each example) defines the
  discriminated union every sign-in-adjacent function returns:
  - `{ status: "complete", tokens }` — signed in; the client hands `tokens` to
    `useAuthActions().setSession`.
  - `{ status: "needs", step, flowId, detail? }` — the server requires another
    step (`verify-email`, `totp`, `confirm-link`, `onboarding`). `flowId`
    resumes the same flow across calls, reloads, and redirects.
  - `{ status: "error", code, message }` — typed, developer-authored rejection
    that is safe to show the user.
- **Error codes** are drawn from a shared registry: `INVALID_CREDENTIALS`,
  `PASSWORD_TOO_SHORT`, `PASSWORD_BREACHED`, `RATE_LIMITED`, `CODE_INVALID`,
  `CODE_EXPIRED`, `FLOW_EXPIRED`, `EMAIL_IN_USE`, `TOS_NOT_ACCEPTED`,
  `SIGNUPS_CLOSED`, `LAST_CREDENTIAL`, `REAUTH_REQUIRED`, `LINK_CONFLICT`.
- **Enumeration resistance**: flows that take an email never reveal whether an
  account exists (the stubs' TODOs spell out the required behavior per flow).
- **The app owns `users`**: each example's schema has its own `users` table
  with flow-specific fields; nothing in the aspirational API dictates its
  shape.
- `refreshSession` / `signOut` stubs match the existing client contract
  (`ConvexAuthProvider` from `@convex-dev/auth/react`), so the client wiring
  is real code today.
- `convex/_generated` is not checked in; `npx convex dev` creates it.

## The flows

| Example | Use case | Aspirational surface (beyond `refreshSession`/`signOut`) |
|---|---|---|
| `flow-password-email-verify` | Email+password sign-up; **no user document until the email is verified** | `signUp`, `verifyEmail`, `resendVerification`, `signIn` |
| `flow-email-otp` | Passwordless: enter email, enter emailed code; user created on first verify | `requestCode`, `verifyCode` |
| `flow-oauth-link` | OAuth sign-in with auto-link on verified email and **confirmed linking** when trust is insufficient | `startOAuth`, `completeOAuth`, `confirmLinkWithPassword` |
| `flow-onboarding-form` | Required form fields (ToS, profile) **before** the account exists; server-side validation with typed rejections | `signUp`, `completeOnboarding`, `flowStatus` |
| `flow-anonymous-upgrade` | Guest session with real data → upgrade to email+password keeping the same user | `signInAnonymously`, `upgradeAccount` |
| `flow-totp-mfa` | Password → dynamic TOTP challenge; enrollment + backup codes | `signIn`, `verifyTotp`, `useBackupCode`, `startTotpEnrollment`, `confirmTotpEnrollment` |
| `flow-step-up` | Sensitive actions require **recent** re-authentication without signing out | `reauthWithPassword`, plus app mutations throwing `REAUTH_REQUIRED` |
| `flow-settings-security` | Account security page: linked identities, active sessions, passkeys | `listIdentities`, `unlinkIdentity`, `listSessions`, `revokeSession`, `revokeOtherSessions`, `listPasskeys`, `addPasskey`, `renamePasskey`, `removePasskey` |

## Evaluating with these fixtures

**API cleanliness**: implement the stubs (or re-express the flow against the
real v2 API) and diff against the fixture. Things to watch: does the client
still drive UI off one discriminated union? Did the implementation force new
fields/indexes onto `users`? Did multi-step flows stay resumable? How many
lines/concepts did each flow cost?

**Agent one-shot**: give an agent the example directory (README + stubs +
client) and the v2 docs, ask it to make the flow work end-to-end, and grade:
does it typecheck, do the acceptance criteria in the README hold, did it need
undocumented knowledge? Compare across flows to find where the API's
"pit of success" ends.

Please do not commit generated files (`convex/_generated`, `node_modules`)
from these examples.
