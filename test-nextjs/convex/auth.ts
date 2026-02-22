import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import GitHub from "@auth/core/providers/github";
import { convexAuth, AuthErrorCode } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
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
        // Trigger structured error handling for e2e tests
        if (secret === "test-structured-error") {
          throw new Error("INVALID_CREDENTIALS");
        }
        if (secret === "test-returned-error") {
          throw new Error("RATE_LIMITED");
        }
        throw new Error("Invalid secret");
      },
    }),
  ],
  callbacks: {
    handleError(_ctx, args) {
      // Return code for RATE_LIMITED (exercises result.error path)
      if (args.error === AuthErrorCode.RATE_LIMITED) {
        return args.error;
      }
      // Throw for all others (exercises ConvexError proxy path)
      throw new ConvexError({ code: args.error });
    },
  },
});
