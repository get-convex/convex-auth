import { mutationGeneric } from "convex/server";
import {
  defineProvider,
  vSignInSuccess,
  type SignInSuccess,
} from "../../lib/types";
import { ComponentApi } from "./_generated/component";

/**
 * An anonymous accounts provider.
 *
 * Useful to establish an authenticated session without requiring a user
 * to provide any credentials.
 *
 * There is no support for allowing a user to return with a previously issued
 * anonymous account.
 */
export const Anonymous = defineProvider({
  name: "anonymous",
  setup: ({ completeSignIn }, options: { component: ComponentApi }) => {
    const { component } = options;
    return {
      // Anonymous sign-in cannot fail per-user, so this only ever produces the
      // success arm. It still returns the shared envelope rather than a bare
      // bundle: that is the shape the SSR auth proxy recognizes (and validates
      // before moving the refresh token into its cookie), and it leaves room for
      // a `userError` arm later without another breaking change.
      signInAnonymous: mutationGeneric({
        args: {},
        returns: vSignInSuccess,
        handler: async (ctx): Promise<SignInSuccess> => {
          const anonymousId = await ctx.runMutation(
            component.provider.createAnonymousAccount,
            {},
          );
          const tokens = await completeSignIn(ctx, {
            provider: "anonymous",
            providerAccountId: anonymousId,
            profile: {},
          });
          return { success: true, tokens };
        },
      }),
    };
  },
});
