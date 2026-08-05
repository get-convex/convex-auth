# flow-onboarding-form

**Use case**: sign-up requires app-defined fields (display name, role, a
versioned ToS acceptance) **validated server-side before the account
exists**; typed rejections propagate to the form. Demonstrates both
orderings: fields collected up front with sign-up, and fields completed
after an authentication that arrives without them. Evaluation fixture —
server bodies are `TODO(auth-v2)` stubs. See `../FLOWS.md` for conventions.

## The flow

1. `/signup`: one form collects email + password + profile (display name,
   role select, ToS checkbox) → `auth.signUp` → the server validates the
   password AND the profile before any account exists: missing/stale ToS →
   `TOS_NOT_ACCEPTED`; a bad display name → `INVALID_PROFILE` with a message
   naming the field. On success the app's user-creation hook receives both
   the provider claims and the profile, the `users` row is created fully
   populated, and the client gets `{ status: "complete", tokens }` →
   `setSession(tokens)`. (Email verification is intentionally out of scope
   here — see `flow-password-email-verify`.)
2. If a sign-up parks at `{ status: "needs", step: "onboarding", flowId }`,
   the shared `OnboardingForm` component takes over and finishes via
   `auth.completeOnboarding`.
3. `/oauth-onboarding`: the second ordering — an OAuth sign-in that
   authenticated but arrived without required fields
   (`auth.simulateOAuthArrival`, a fixture-only helper that really returns
   `needs: "onboarding"`). The same `OnboardingForm`, pre-filled from the
   flow's `detail`, submits `auth.completeOnboarding({ flowId, profile })` →
   same validation → `complete` → `setSession(tokens)`. `auth.flowStatus`
   is a reactive query on the parked flow, so the leg is resumable.

## Acceptance criteria

- No `users` document exists when validation fails — a rejection leaves
  zero state behind.
- The accepted ToS version is recorded on the user at creation
  (`tosAcceptedVersion`), not patched in afterwards.
- The same validation code path serves both orderings (up-front `signUp`
  and `completeOnboarding`).
- Typed errors name the offending field: `INVALID_PROFILE` carries a
  message identifying it; ToS problems are always `TOS_NOT_ACCEPTED`.
- The needs-onboarding leg is resumable: `flowStatus` is subscribable and
  returns null once the flow completes or expires.
- `completeOnboarding` is single-use per flow.

## Run

`npx convex dev` generates `convex/_generated`; `pnpm dev` runs it. Until
the stubs are implemented, every auth call throws its TODO
(`simulateOAuthArrival` is real, so the second leg is demoable up to the
final submit).
