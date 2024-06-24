/**
 * Configure {@link Password} provider given a {@link PasswordConfig}.
 *
 * The `Password` provider supports the following flows, determined
 * by the `flow` parameter:
 *
 * - `"signUp"`: Create a new account with a password.
 * - `"signIn"`: Sign in with an existing account and password.
 * - `"reset"`: Request a password reset.
 * - `"reset-verification"`: Verify a password reset code and change password.
 * - `"email-verification"`: If email verification is enabled and `code` is
 *    included in params, verify an OTP.
 *
 * ```ts
 * import Password from "@xixixao/convex-auth/providers/Password";
 * import { convexAuth } from "@xixixao/convex-auth/server";
 *
 * export const { auth, signIn, signOut, store } = convexAuth({
 *   providers: [Password],
 * });
 * ```
 *
 * @module
 */

import { EmailConfig } from "@auth/core/providers";
import ConvexCredentials, {
  ConvexCredentialsUserConfig,
} from "@xixixao/convex-auth/providers/ConvexCredentials";
import {
  GenericDoc,
  createAccount,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
  signInViaProvider,
} from "@xixixao/convex-auth/server";
import {
  DocumentByName,
  GenericDataModel,
  WithoutSystemFields,
} from "convex/server";
import { Value } from "convex/values";
import { Scrypt } from "lucia";

/**
 * The available options to a {@link Password} provider for Convex Auth.
 */
export interface PasswordConfig<DataModel extends GenericDataModel> {
  /**
   * Uniquely identifies the provider, allowing to use
   * multiple different {@link Password} providers.
   */
  id?: string;
  /**
   * Perform checks on provided params and customize the user
   * information stored after sign up, including email normalization.
   *
   * Called for every flow ("signUp", "signIn", "reset" and
   * "reset-verification").
   *
   * @param params The values passed to the `signIn` function.
   */
  profile?: (params: Record<string, Value | undefined>) => WithoutSystemFields<
    DocumentByName<DataModel, "users">
  > & {
    email: string;
  };
  /**
   * Provide hashing and verification functions if you want to control
   * how passwords are hashed.
   */
  crypto?: ConvexCredentialsUserConfig["crypto"];
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
  config: PasswordConfig<DataModel> = {},
) {
  const provider = config.id ?? "password";
  return ConvexCredentials<DataModel>({
    id: "password",
    authorize: async (params, ctx) => {
      const profile = config.profile?.(params) ?? defaultProfile(params);
      const { email } = profile;
      const flow = params.flow as string;
      const secret = params.password as string;
      let account: GenericDoc<DataModel, "accounts">;
      let user: GenericDoc<DataModel, "users">;
      if (flow === "signUp") {
        if (secret === undefined) {
          throw new Error("Missing `password` param for `signUp` flow");
        }
        const created = await createAccount(ctx, {
          provider,
          account: { id: email, secret },
          profile: profile as any,
          shouldLink: config.verify !== undefined,
        });
        ({ account, user } = created);
      } else if (flow === "signIn") {
        if (secret === undefined) {
          throw new Error("Missing `password` param for `signIn` flow");
        }
        const retrieved = await retrieveAccount(ctx, {
          provider,
          account: { id: email, secret },
        });
        if (retrieved === null) {
          throw new Error("Invalid credentials");
        }
        ({ account, user } = retrieved);
        // START: Optional, support password reset
      } else if (flow === "reset") {
        if (!config.reset) {
          throw new Error(`Password reset is not enabled for ${provider}`);
        }
        const { account } = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        return await signInViaProvider(ctx, config.reset, {
          accountId: account._id,
          params,
        });
      } else if (flow === "reset-verification") {
        if (!config.reset) {
          throw new Error(`Password reset is not enabled for ${provider}`);
        }
        if (params.newPassword === undefined) {
          throw new Error(
            "Missing `newPassword` param for `reset-verification` flow",
          );
        }
        const result = await signInViaProvider(ctx, config.reset, { params });
        if (result === null) {
          throw new Error("Invalid code");
        }
        const { userId, sessionId } = result;
        const secret = params.newPassword as string;
        await modifyAccountCredentials(ctx, {
          provider,
          account: { id: email, secret },
        });
        await invalidateSessions(ctx, { userId, except: [sessionId] });
        return { userId, sessionId };
        // END
        // START: Optional, email verification during sign in
      } else if (flow === "email-verification") {
        if (!config.verify) {
          throw new Error(`Email verification is not enabled for ${provider}`);
        }
        const { account } = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        return await signInViaProvider(ctx, config.verify, {
          accountId: account._id,
          params,
        });
        // END
      } else {
        throw new Error(
          "Missing `flow` param, it must be one of " +
            '"signUp", "signIn", "reset", "reset-verification" or ' +
            '"email-verification"!',
        );
      }
      // START: Optional, email verification during sign in
      if (config.verify && !account.emailVerified) {
        return await signInViaProvider(ctx, config.verify, {
          accountId: account._id,
          params,
        });
      }
      // END
      return { userId: user._id };
    },
    crypto: {
      async hashSecret(password: string) {
        return await new Scrypt().hash(password);
      },
      async verifySecret(password: string, hash: string) {
        return await new Scrypt().verify(hash, password);
      },
    },
    ...config,
  });
}

function defaultProfile(params: Record<string, unknown>) {
  const flow = params.flow as string;
  if (flow === "signUp" || flow === "reset-verification") {
    const password = (
      flow === "signUp" ? params.password : params.newPassword
    ) as string;
    if (!password || password.length < 8) {
      throw new Error("Invalid password");
    }
  }
  return {
    email: params.email as string,
  };
}
