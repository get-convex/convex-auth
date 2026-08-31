# react-password-requirements example

A copy of the `react-password` example whose evaluating `onSignIn` callback
_suspends_ sign-ins with requirements instead of always completing them. It
demos a fake second factor (`mathFactor:problem`): solving a small math
problem gates _every_ session mint, sign-up included. The verified
credentials are parked in a server-side sign-in attempt; the client answers
against the factor's own endpoints, which record the proof as a **fact** on
the attempt, then resumes via `continueSignInWithPassword` (the hooks'
`continueWith`).

## The typed requirement registry

The framework treats requirements as opaque `{ kind: string, data?: any }`
payloads until an app closes the vocabulary by passing a plain array of
`requirement(...)` declarations (from `@convex-dev/auth/lib/requirements`)
to the provider setup's `signInRequirements` option. Each requirement
declares its `kind`, the `data` payload the server sends down with it, and
the `facts` recorded once server-side verification succeeds. This example
registers the array on `setupUsernamePassword` (`convex/auth.ts`), and it
threads through the whole stack:

- The evaluating callback (`convex/users.ts`) derives its `facts` and
  `returns` validators from the same specs via `requirementValidators`, so
  declaration and enforcement can't drift — a verdict emitting an
  unregistered kind fails validation at runtime and, via
  `attachUserCallbacks`, the build.
- The generated `api` types carry the closed requirement union, so the
  client's per-kind handlers record (`renderRequirements`) is
  exhaustiveness-checked — registering a new kind breaks the build until
  the UI handles it (see `src/routes/requirementsStep.tsx`).

The example's other interesting pieces:

- `convex/lib/mathFactor.ts` — the second factor packaged as a pluggable
  capability (a stand-in for a real TOTP or passkey verifier). Its setup
  value provides its table (mounted in `schema.ts`), its challenge/verify
  endpoint handlers (mounted in `auth.ts`), and its requirement spec — so
  registering `mathFactor:problem` proves the thing that satisfies it is
  actually installed. Verification happens out-of-band from the sign-in
  flow, against the factor's own endpoints, and success is recorded as a
  `mathVerified` **fact** on the sign-in attempt through the core's
  `recordAttemptFacts` primitive — reachable only from server code, so a
  recorded fact proves the verifying code actually ran. Failed answers are
  metered against the attempt's continuation cap (`penalizeAttempt`), and
  verification binds to the attempt's subject (`getAttemptContext`), never
  to caller-supplied identity. A fresh sign-in starts with an empty facts
  bag and must re-prove the factor.
- `convex/users.ts` — the evaluator that judges `(user, profile, facts)` and
  returns a verdict. It's a pure judge: the math gate is a presence check on
  the facts bag; it never evaluates or records anything itself.
- `src/routes/requirementsStep.tsx` — the requirements UI both the log-in
  and sign-up pages share, built on the framework's `useRequirementsFlow`
  (owns the continue/adopt/expire state machine) and `renderRequirements`
  (typed per-kind dispatch): the app only supplies the math input and the
  copy.

Because the user, account and credentials are created _eagerly_ (only the
session is withheld), an abandoned incomplete sign-up self-heals: signing
_in_ later resolves the same user and re-prompts for what's still
outstanding — and re-signing-up reports the taken username.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-password-requirements
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx @convex-dev/auth     # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
npm run dev              # start the Vite frontend
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
