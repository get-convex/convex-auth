import { ComponentApi } from "./_generated/component";
import { defineProvider } from "../../lib/types";
import { actionGeneric } from "convex/server";

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
  setup: (completeSignIn, options: { component: ComponentApi }) => {
    const { component } = options;
    return {
      signInAnonymous: actionGeneric({
        args: {},
        handler: async (ctx) => {
          const anonymousId = await ctx.runMutation(
            component.provider.createAnonymousAccount,
            {},
          );
          return await completeSignIn(ctx, {
            provider: "anonymous",
            providerAccountId: anonymousId,
            profile: {},
          });
        },
      }),
    };
  },
});
