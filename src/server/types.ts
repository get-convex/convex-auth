import {
  Provider as AuthProviderConfig,
  CredentialsConfig,
  EmailConfig,
  OAuth2Config,
  OIDCConfig,
} from "@auth/core/providers";
import { WebAuthnConfig } from "@auth/core/providers/webauthn";
import { Theme, User } from "@auth/core/types";
import {
  AnyDataModel,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import { GenericId } from "convex/values";

/**
 * The config for the Convex Auth library, passed to `convexAuth`.
 */
export type ConvexAuthConfig = {
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
  onSignIn?: OnSignIn<any, any, any>;
};

export type OnSignIn<
  Profile = User,
  UserId extends string = GenericId<"users">,
  DataModel extends GenericDataModel = AnyDataModel,
> = (
  ctx: GenericMutationCtx<DataModel>,
  args: {
    userId: UserId | null;
    profile: Profile;
    provider: AuthProviderMaterializedConfig;
  },
) => Promise<UserId>;

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
  | CredentialsConfig
  | WebAuthnConfig;
