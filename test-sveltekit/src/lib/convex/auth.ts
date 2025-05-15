import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import GitHub from "@auth/core/providers/github";
import { convexAuth } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    GitHub,
    ConvexCredentials({
      id: "secret",
      authorize: async (params, ctx) => {
        const secret = params.secret;
        if (
          process.env.AUTH_E2E_TEST_SECRET &&
          secret === process.env.AUTH_E2E_TEST_SECRET
        ) {
          const user = await ctx.runQuery(internal.tests.getTestUser);
          return { userId: user!._id };
        }
        throw new Error("Invalid secret");
      },
    }),
  ],
});
