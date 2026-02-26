import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  jwt: {
    customClaims: async (_ctx, _args) => {
      return { sub: "should-fail" };
    },
  },
  providers: [Password],
});
