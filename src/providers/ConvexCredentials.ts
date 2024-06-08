/**
 * Configure {@link ConvexCredentials} provider given a {@link ConvexCredentialsConfig}.
 *
 * This is for very custom authentication implementation, often you can
 * use the `Password` provider instead.
 *
 * @module
 */

import { CredentialsConfig } from "@auth/core/providers";
import { GenericActionCtxWithAuthConfig } from "@xixixao/convex-auth/server";
import { GenericDataModel } from "convex/server";
import { GenericId } from "convex/values";

/**
 * The available options to a {@link ConvexCredentials} provider for Convex Auth.
 */
export interface ConvexCredentialsConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> {
  /**
   * Uniquely identifies the provider, allowing to use
   * multiple different {@link ConvexCredentials} providers.
   */
  id?: string;
  /**
   * Gives full control over how you handle the credentials received from the user.
   *
   * This method expects a user ID to be returned for a successful login.
   *
   * If an error is thrown or `null` is returned, the sign-in will fail.
   */
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

/**
 * The Credentials provider allows you to handle signing in with arbitrary credentials,
 * such as a username and password, domain, or two factor authentication or hardware device (e.g. YubiKey U2F / FIDO).
 */
export default function ConvexCredentials<DataModel extends GenericDataModel>(
  config: ConvexCredentialsConfig<DataModel>,
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
