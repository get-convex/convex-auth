import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupAnonymous } from "@convex-dev/auth/providers/anonymous/setup";
import { setupUsernamePassword } from "@convex-dev/auth/providers/password/setup";

// The core owns sessions, accounts, and JWT minting. Each provider is wired to
// it with its own setup function, and only hands back its functions once the
// app attaches the callbacks that create its user rows. Each provider exposes
// the functions its client hooks call: `signInAnonymous` for the anonymous
// provider, `signUpWithPassword` / `signInWithPassword` for the password one.
// Under SSR those calls get proxied to Convex via the SSR host. The sign-in
// functions exposed here are wired up to be proxied in src/lib/serverAuth.ts.
const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

// `onSignIn` is optional, and runs on every sign-in including the first. This
// app uses it to stamp the user's last sign-in. Both providers are attached to
// the same pair of callbacks, which is allowed because the callbacks declare
// args wide enough for either provider to call them (see convex/users.ts).
// The annotated intermediate variables are the price of the shared callbacks
// above. Checking whether a callback *accepts* what a provider sends takes a
// generic `attachUserCallbacks`, and a generic call that has to type an
// `internal.*` argument to produce an exported value is self-referential:
// `internal` is built from this module's own exports. Annotating the variable
// gives TypeScript the type without resolving the call, breaking the cycle;
// exporting the chained call directly fails with TS7022 (as the two
// single-provider examples currently do).
type AnonymousApi = ReturnType<
  ReturnType<typeof setupAnonymous<"users">>["attachUserCallbacks"]
>;
const anonymousApi: AnonymousApi = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
export const { signInAnonymous } = anonymousApi;

type PasswordApi = ReturnType<
  ReturnType<typeof setupUsernamePassword<"users">>["attachUserCallbacks"]
>;
const passwordApi: PasswordApi = setupUsernamePassword(core, {
  component: components.authPasswordProvider,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
export const { signUpWithPassword, signInWithPassword } = passwordApi;
