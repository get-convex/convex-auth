import { makeFunctionReference } from "convex/server";
import type { ComponentApi } from "./_generated/component.js";
import { setupUsernamePassword } from "./setup.js";
import schema from "./setupTestSchema.js";

const passwordComponent = {
  public: {
    setPassword: makeFunctionReference("setupTestPassword:setPassword"),
    verifyPassword: makeFunctionReference("setupTestPassword:verifyPassword"),
  },
} as unknown as ComponentApi;

const auth = setupUsernamePassword({
  schema,
  component: passwordComponent,
  completeSignIn: async (_ctx, claims) => ({
    accessToken: `access:${claims.providerAccountId}`,
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: `refresh:${claims.providerAccountId}`,
    refreshTokenExpiresAt: Date.now() + 120_000,
    userId: claims.providerAccountId,
  }),
});

export const { signInWithPassword, signUpWithPassword } = auth;
