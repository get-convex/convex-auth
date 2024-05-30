import { CommonProviderOptions, CredentialsConfig } from "@auth/core/providers";
import { GenericDataModel } from "convex/server";
import { GenericId } from "convex/values";
import { GenericActionCtxWithAuthConfig } from "@xixixao/convex-auth/server";

export interface ConvexCredentialsConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> extends CommonProviderOptions {
  authorize: (
    /**
     * The available keys are determined by your call to `signIn()` on the client.
     *
     * You can add basic validation depending on your use case,
     * or you can use a popular library like [Zod](https://zod.dev) for validating
     * the input.
     */
    credentials: Partial<Record<string, unknown>>,
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => Promise<{ id: GenericId<"users"> } | null>;
  /**
   * Provide hashing and verification functions if you're
   * storing account secrets and want to control
   * how they're hashed.
   *
   * These functions will be called during
   * the `createAccountWithCredentials` and `retrieveAccountWithCredentials`
   * execution.
   */
  crypto?: {
    /**
     * Function used to hash the secret.
     */
    hashSecret: (secret: string) => Promise<string>;
    /**
     * Function used to verify that the secret
     * matches the stored hash.
     */
    verifySecret: (secret: string, hash: string) => Promise<boolean>;
  };

  /**
   * Called after successful sign-in code verification.
   *
   * Useful for implementing account modification flows that require
   * sign-in verification (such as password reset via email with OTP).
   */
  afterCodeVerification?: (
    /**
     * The available keys are determined by your call to `verifyCode()` on the client.
     *
     * You can add basic validation depending on your use case,
     * or you can use a popular library like [Zod](https://zod.dev) for validating
     * the input.
     */
    credentials: Partial<Record<string, unknown>>,
    verified: {
      userId: GenericId<"users">;
      providerAccountId: string;
      sessionId: GenericId<"sessions">;
    },
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => Promise<void>;
}

export default function ConvexCredentials<DataModel extends GenericDataModel>(
  config: Partial<ConvexCredentialsConfig<DataModel>>,
): CredentialsConfig {
  return {
    id: "credentials",
    name: "Credentials",
    type: "credentials",
    credentials: {},
    authorize: () => null,
    // @ts-expect-error Internal
    options: config,
  };
}
