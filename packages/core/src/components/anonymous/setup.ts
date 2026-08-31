import {
  vSignInSuccess,
  type SignInSuccess,
  type UserCallbacks,
} from "../../lib/types.ts";
import type { AuthCore } from "../core/setup.ts";
import { ComponentApi } from "./_generated/component.ts";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "anonymous";

/**
 * An anonymous accounts provider.
 *
 * Useful to establish an authenticated session without requiring a user
 * to provide any credentials.
 *
 * There is no support for allowing a user to return with a previously issued
 * anonymous account.
 *
 * ```ts
 * const core = setupCore({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * export const { signInAnonymous } = setupAnonymous(core, {
 *   component: components.authAnonymous,
 * }).attachUserCallbacks({ createUser: internal.users.createUserAnonymous });
 * ```
 */
export function setupAnonymous<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: {
    /** The mounted anonymous component (`components.authAnonymous`). */
    component: ComponentApi;
  },
) {
  const { component } = options;

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get this provider's functions to export.
     *
     * Every anonymous sign-in establishes a new account, so `createUser` runs
     * every time. An `onSignIn` is still worth attaching for work an app does
     * on every sign-in whatever the provider, since it runs right afterwards.
     */
    attachUserCallbacks({
      createUser,
      onSignIn,
    }: UserCallbacks<"anonymous", Record<string, never>, UsersTable>) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createUser,
        onSignIn,
      });

      return {
        // Anonymous sign-in cannot fail per-user, so this only ever produces
        // the success arm. It still returns the shared envelope rather than a
        // bare bundle: that is the shape the SSR auth proxy recognizes (and
        // validates before moving the refresh token into its cookie), and it
        // leaves room for a `userError` arm later without another breaking
        // change.
        signInAnonymous: authMutation({
          args: {},
          returns: vSignInSuccess,
          handler: async (ctx): Promise<SignInSuccess> => {
            const anonymousId = await ctx.runMutation(
              component.provider.createAnonymousAccount,
              {},
            );
            const outcome = await ctx.convexAuth.completeSignUp({
              providerAccountId: anonymousId,
              profile: {},
            });
            if (outcome.status !== "session-created") {
              // Unreachable: this provider registers no requirements, so the
              // core has nothing to withhold the session for.
              throw new Error(
                "Anonymous sign-in came back without a session: " +
                  outcome.status,
              );
            }
            return { status: "complete", tokens: outcome.tokens };
          },
        }),
      };
    },
  };
}
