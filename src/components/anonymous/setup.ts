import { ComponentApi } from "./_generated/component";
import { defineProvider } from "../../lib/types";
import { actionGeneric } from "convex/server";
import { v } from "convex/values";

/**
 * An anonymous accounts provider.
 *
 * Useful to establish an authenticated session without requiring a user
 * to provide any credentials.
 *
 * When installing, pair with {@link AnonymousOptions} to customize the
 * behavior in your application.
 *
 * The {@link AnonymousOptions.allowReturningAccounts} value controls whether a
 * previously issued anonymous ID can be used to re-establish a session. It
 * defaults to `false`.
 */
export const Anonymous = defineProvider({
  name: "anonymous",
  setup: (completeSignIn, options: AnonymousOptions) => {
    const { component, allowReturningAccounts = false } = options;
    return {
      signInAnonymous: actionGeneric({
        args: {
          id: v.optional(v.string()),
        },
        handler: async (ctx, args) => {
          if (args.id && !allowReturningAccounts) {
            throw Error("returning acccounts not allowed");
          }
          const anonymousId = await ctx.runMutation(
            component.provider.signInAnonymous,
            args,
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

type AnonymousOptions = {
  component: ComponentApi;
  /**
   * Whether returning anonymous IDs will be accepted by the {@link Anonymous} provider.
   */
  allowReturningAccounts?: boolean;
};
