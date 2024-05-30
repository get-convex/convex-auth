import { CommonProviderOptions, EmailConfig } from "@auth/core/providers";
import {
  DocumentByName,
  GenericDataModel,
  WithoutSystemFields,
} from "convex/server";
import { Scrypt } from "lucia";
import {
  createAccountWithCredentials,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
  retrieveAccountWithCredentials,
  signInViaProvider,
} from "../server/index";
import ConvexCredentials, {
  ConvexCredentialsConfig,
} from "./ConvexCredentials";

interface PasswordConfig<DataModel extends GenericDataModel>
  extends CommonProviderOptions {
  /**
   * Perform checks on provided params and customize the user
   * information stored after sign up.
   *
   * @param params The values passed to the `signIn` function.
   */
  profile?: (params: Record<string, unknown>) => WithoutSystemFields<
    DocumentByName<DataModel, "users">
  > & {
    email: string;
  };
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
 * Password are by default hashed using Scrypt from Lucia.
 * You can customize the hashing via the `crypto` option.
 *
 * Email verification is not required unless you pass
 * an email provider to the `verify` option.
 */
export default function Password<DataModel extends GenericDataModel>(
  config: Partial<PasswordConfig<DataModel>>,
) {
  const provider = config.id ?? "password";
  return ConvexCredentials<DataModel>({
    id: "password",
    authorize: async ({ flow, ...params }, ctx) => {
      const email = params.email as string;
      const secret = params.password as string;
      let user;
      if (flow === "signUp") {
        const profile = config.profile?.(params) ?? defaultProfile(params);
        user = await createAccountWithCredentials(ctx, {
          provider,
          account: { id: email, secret },
          profile,
        });
      } else if (flow === "signIn") {
        user = await retrieveAccountWithCredentials(ctx, {
          provider,
          account: { id: email, secret },
        });
        if (user === null) {
          throw new Error("Invalid credentials");
        }
        // START: Optional, support password reset
      } else if (flow === "reset" && config.reset) {
        const user = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        if (user === null) {
          throw new Error("Invalid credentials");
        }
        return await signInViaProvider(ctx, config.reset, { userId: user._id });
        // END
      } else {
        throw new Error("Must specify `flow`");
      }
      // START: Optional, email verification during sign in
      if (config.verify && user.emailVerified !== true) {
        return await signInViaProvider(ctx, config.verify, {
          userId: user._id,
        });
      }
      // END
      return { id: user._id };
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
