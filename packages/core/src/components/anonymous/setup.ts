import {
  vSignInSuccess,
  type CreateOrUpdateUserFn,
  type SignInSuccess,
} from "../../lib/types";
import type { AuthCore } from "../core/setup";
import { ComponentApi } from "./_generated/component";

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
 * const core = setupCore({ component: components.core });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * export const { signInAnonymous } = setupAnonymous(core, {
 *   component: components.authAnonymous,
 * }).attachUserCallback(internal.users.createOrUpdateUser);
 * ```
 */
export function setupAnonymous(
  core: AuthCore,
  options: {
    /** The mounted anonymous component (`components.authAnonymous`). */
    component: ComponentApi;
  },
) {
  const { component } = options;

  return {
    /**
     * Supply the app's create-or-update-user mutation (see
     * {@link CreateOrUpdateUserFn} for how its args must be declared) and
     * get this provider's functions to export.
     */
    attachUserCallback(
      createOrUpdateUser: CreateOrUpdateUserFn<
        "anonymous",
        Record<string, never>
      >,
    ) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createOrUpdateUser,
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
            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: anonymousId,
              profile: {},
            });
            return { success: true, tokens };
          },
        }),
      };
    },
  };
}
