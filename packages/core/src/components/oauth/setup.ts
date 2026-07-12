import { mutationGeneric } from "convex/server";
import { defineProvider } from "../../lib/types";
import { ComponentApi } from "./_generated/component";

export const Oauth = defineProvider({
  name: "oauth",
  setup: ({ completeSignIn }, options: { component: ComponentApi }) => {
    const { component } = options;
    return {
      signIn: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          const anonymousId = await ctx.runMutation(
            component.provider.createOauthAccount,
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
