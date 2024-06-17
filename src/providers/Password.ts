/**
 * Configure {@link Password} provider given a {@link PasswordConfig}.
 *
 * @module
 */

import { EmailConfig } from "@auth/core/providers";
import ConvexCredentials, {
  ConvexCredentialsConfig,
} from "@xixixao/convex-auth/providers/ConvexCredentials";
import {
  GenericDoc,
  createAccountWithCredentials,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
  retrieveAccountWithCredentials,
  signInViaProvider,
} from "@xixixao/convex-auth/server";
import { GenericDataModel } from "convex/server";
import { Scrypt } from "lucia";

/**
 * The available options to a {@link Password} provider for Convex Auth.
 */
export interface PasswordConfig<
  Profile extends { email: string } = { email: string },
> {
  /**
   * Uniquely identifies the provider, allowing to use
   * multiple different {@link Password} providers.
   */
  id?: string;
  /**
   * Perform checks on provided params and customize the user
   * information stored after sign up.
   *
   * @param params The values passed to the `signIn` function.
   */
  profile?: (params: Record<string, unknown>) => Profile;
  /**
   * Provide hashing and verification functions if you want to control
   * how passwords are hashed.
   */
  crypto?: ConvexCredentialsConfig["crypto"];
  /**
   * An Auth.js email provider used to require verification
   * before password reset.
   */
  reset?: EmailConfig | ((...args: any) => EmailConfig);
  /**
   * An Auth.js email provider used to require verification
   * before sign up / sign in.
   */
  verify?: EmailConfig | ((...args: any) => EmailConfig);
}

/**
 * Email and password authentication provider.
 *
 * Passwords are by default hashed using Scrypt from Lucia.
 * You can customize the hashing via the `crypto` option.
 *
 * Email verification is not required unless you pass
 * an email provider to the `verify` option.
 */
export default function Password<DataModel extends GenericDataModel>(
  config: PasswordConfig = {},
) {
  const provider = config.id ?? "password";
  return ConvexCredentials<DataModel>({
    id: "password",
    authorize: async ({ flow, ...params }, ctx) => {
      const email = params.email as string;
      const secret = params.password as string;
      let account: GenericDoc<DataModel, "accounts">;
      if (flow === "signUp") {
        const profile = config.profile?.(params) ?? defaultProfile(params);
        const created = await createAccountWithCredentials(ctx, {
          provider,
          account: { id: email, secret },
          profile,
        });
        account = created;
      } else if (flow === "signIn") {
        const retrieved = await retrieveAccountWithCredentials(ctx, {
          provider,
          account: { id: email, secret },
        });
        if (retrieved === null) {
          throw new Error("Invalid credentials");
        }
        account = retrieved;
        // START: Optional, support password reset
      } else if (flow === "reset" && config.reset) {
        const retrieved = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        if (retrieved === null) {
          throw new Error("Invalid credentials");
        }
        account = retrieved;
        return await signInViaProvider(ctx, config.reset, {
          accountId: account._id,
        });
        // END
      } else {
        throw new Error("Must specify `flow`");
      }
      // START: Optional, email verification during sign in
      if (config.verify && !account.emailVerified) {
        return await signInViaProvider(ctx, config.verify, {
          accountId: account._id,
        });
      }
      // END
      return { id: account.userId as string };
    },
    crypto: {
      async hashSecret(password: string) {
        return await new Scrypt().hash(password);
      },
      async verifySecret(password: string, hash: string) {
        return await new Scrypt().verify(hash, password);
      },
    },
    // START: Optional, support password reset
    afterCodeVerification: async (
      { flow, newPassword },
      { providerAccountId, userId, sessionId },
      ctx,
    ) => {
      if (flow !== "reset") {
        return;
      }
      await modifyAccountCredentials(ctx, {
        provider,
        account: {
          id: providerAccountId,
          secret: newPassword as string,
        },
      });
      await invalidateSessions(ctx, { userId, except: [sessionId] });
    },
    // END
    ...config,
  });
}

function defaultProfile(params: Record<string, unknown>) {
  const password = params.password as string;
  if (!password || password.length < 8) {
    throw new Error("Invalid password");
  }
  return {
    email: params.email as string,
  };
}
