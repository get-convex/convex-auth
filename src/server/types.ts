import {
  Provider as AuthjsProviderConfig,
  CredentialsConfig,
  EmailConfig,
  OAuth2Config,
  OIDCConfig,
} from "@auth/core/providers";
import { Theme } from "@auth/core/types";
import {
  AnyDataModel,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import { GenericId } from "convex/values";
import { ConvexCredentialsUserConfig } from "../providers/ConvexCredentials";

/**
 * The config for the Convex Auth library, passed to `convexAuth`.
 */
export type ConvexAuthConfig<
  DataModel extends GenericDataModel = AnyDataModel,
> = {
  /**
   * A list of authentication provider configs.
   *
   * You can import existing configs from
   * - `@auth/core/providers/<provider-name>`
   * - `@xixixao/convex-auth/providers/<provider-name>`
   */
  providers: AuthProviderConfig[];
  /**
   * Theme used for emails.
   * See [Auth.js theme docs](https://authjs.dev/reference/core/types#theme).
   */
  theme?: Theme;
  /**
   * Session configuration.
   */
  session?: {
    /**
     * How long can a user session last without the user reauthenticating.
     *
     * Defaults to 30 days.
     */
    totalDurationMs?: number;
    /**
     * How long can a user session last without the user being active.
     *
     * Defaults to 30 days.
     */
    inactiveDurationMs?: number;
  };
  /**
   * JWT configuration.
   */
  jwt?: {
    /**
     * How long is the JWT valid for after it is signed initially.
     *
     * Defaults to 1 hour.
     */
    durationMs?: number;
  };
  /**
   * Sign-in configuration.
   */
  signIn?: {
    /**
     * How many times can the user fail to provide the correct credentials
     * (password, OTP) per hour.
     *
     * Defaults to 10 times per hour (that is 10 failed attempts, and then
     * allow another one every 6 minutes).
     */
    maxFailedAttempsPerHour?: number;
  };
  callbacks?: {
    /**
     *
     */

    /**
     * Completely control account linking via this callback.
     *
     * This callback is called during the sign-in process,
     * before account creation and token generation.
     * If specified, this callback is responsible for creating
     * or updating the user document.
     *
     * For "credentials" providers, the callback is only called
     * when `createAccount` is called.
     */
    createOrUpdateUser?: (
      ctx: GenericMutationCtx<DataModel>,
      args: {
        /**
         * If this is a sign-in to an existing account,
         * this is the existing user ID linked to that account.
         */
        existingUserId: GenericId<"users"> | null;
        /**
         * The provider type or "verification" if this callback is called
         * after an email or phone token verification.
         */
        type: "oauth" | "credentials" | "email" | "phone" | "verification";
        /**
         * The provider used for the sign-in, or the provider
         * tied to the account which is having the email or phone verified.
         */
        provider: AuthProviderMaterializedConfig;
        /**
         * - The profile returned by the OAuth provider's `profile` method.
         * - The profile passed to `createAccount` from a ConvexCredentials
         * config.
         * - The email address to which an email will be sent.
         * - The phone number to which a text will be sent.
         */
        profile: Record<string, unknown> & {
          email?: string;
          phone?: string;
          emailVerified?: boolean;
          phoneVerified?: boolean;
        };
        /**
         * The `shouldLink` argument passed to `createAccount`.
         */
        shouldLink?: boolean;
      },
    ) => Promise<GenericId<"users">>;
  };
};

/**
 * Same as Auth.js provider configs, but adds phone provider
 * for verification via SMS or another phone-number-connected messaging
 * service.
 */
export type AuthProviderConfig =
  | Exclude<
      AuthjsProviderConfig,
      CredentialsConfig | ((...args: any) => CredentialsConfig)
    >
  | ConvexCredentialsConfig
  | ((...args: any) => ConvexCredentialsConfig)
  | PhoneConfig
  | ((...args: any) => PhoneConfig);

/**
 * Same as email provider config, but verifies
 * phone number instead of the email address.
 */
export interface PhoneConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> {
  id: string;
  type: "phone";
  /**
   * Token expiration in seconds.
   */
  maxAge: number;
  /**
   * Send the phone number verification request.
   */
  sendVerificationRequest: (
    params: {
      identifier: string;
      url: string;
      expires: Date;
      provider: PhoneConfig;
      token: string;
    },
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => Promise<void>;
  /**
   * Defaults to `process.env.AUTH_<PROVIDER_ID>_KEY`.
   */
  apiKey?: string;
  /**
   * Override this to generate a custom token.
   * Note that the tokens are assumed to be cryptographically secure.
   * Any tokens shorter than 24 characters are assumed to not
   * be secure enough on their own, and require providing
   * the original `phone` used in the initial `signIn` call.
   * @returns
   */
  generateVerificationToken?: () => Promise<string>;
  /**
   * Normalize the phone number.
   * @param identifier Passed as `phone` in params of `signIn`.
   * @returns The phone number used in `sendVerificationRequest`.
   */
  normalizeIdentifier?: (identifier: string) => string;
  options: PhoneUserConfig;
}

/**
 * Configurable options for a phone provider config.
 */
export type PhoneUserConfig = Omit<Partial<EmailConfig>, "options" | "type">;

/**
 * Similar to Auth.js Credentials config.
 */
export type ConvexCredentialsConfig = ConvexCredentialsUserConfig<any> & {
  type: "credentials";
  id: string;
};

/**
 * Your `ActionCtx` enriched with `ctx.auth.config` field with
 * the config passed to `convexAuth`.
 */
export type GenericActionCtxWithAuthConfig<DataModel extends GenericDataModel> =
  GenericActionCtx<DataModel> & {
    auth: { config: ConvexAuthMaterializedConfig };
  };

/**
 * The config for the Convex Auth library, passed to `convexAuth`,
 * with defaults and initialized providers.
 *
 * See {@link ConvexAuthConfig}
 */
export type ConvexAuthMaterializedConfig = {
  providers: AuthProviderMaterializedConfig[];
  theme: Theme;
  session?: {
    totalDurationMs?: number;
    inactiveDurationMs?: number;
  };
  jwt?: {
    durationMs?: number;
  };
};

/**
 * Materialized Auth.js provider config.
 */
export type AuthProviderMaterializedConfig =
  | OIDCConfig<any>
  | OAuth2Config<any>
  | EmailConfig
  | PhoneConfig
  | ConvexCredentialsConfig;
