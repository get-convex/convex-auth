import {
  AnyDataModel,
  DataModelFromSchemaDefinition,
  DocumentByName,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
  TableNamesInDataModel,
} from "convex/server";
import type { Infer } from "convex/values";
import { GenericId, Value } from "convex/values";

import { vApiKeyDoc, vUserDoc } from "../component/model";
import schema from "../component/schema";
import type { AuthComponentApi } from "./component/api";
import type { CredentialsConfig } from "../providers/credentials";
import type { AuthEventHandlerMap, OidcClaims, SamlClaims, ScimRawAttributes } from "./events";
import type { AuthTokens, SignInFlowResult } from "../shared/results";

/**
 * A value that is either `T` or a `PromiseLike<T>`.
 *
 * @typeParam T - The underlying value type.
 */
type Awaitable<T> = T | PromiseLike<T>;

/**
 * A single role definition within the permissions config.
 *
 * Each role has an optional human-readable label and a list of grant strings
 * that members with this role receive.
 *
 * @see {@link PermissionsConfig}
 */
type PermissionRoleDefinition = {
  /** Optional stable identifier (defaults to the record key). */
  id?: string;
  /** Human-readable label for admin UIs. */
  label?: string;
  /** Permission grant strings conferred by this role. */
  grants: string[];
};

/**
 * Permissions configuration mapping role IDs to {@link PermissionRoleDefinition}s.
 *
 * Pass this as `permissions` in {@link ConvexAuthConfig}. Grants are the
 * atomic permissions your app checks; roles are named grant bundles assigned to
 * memberships.
 *
 * @see {@link PermissionRoleDefinition}
 * @see {@link ConvexAuthConfig}
 */
export type PermissionsConfig = {
  grants?: readonly string[];
  roles: Record<string, PermissionRoleDefinition>;
};

/** Identity enrichment mode for auth telemetry spans. */
type AuthTelemetryIdentityMode = "none" | "hashed" | "raw";

/** Individual identity fields that can be attached to telemetry spans. */
type AuthTelemetryIdentityFields = {
  userId?: boolean;
  sessionId?: boolean;
  refreshTokenId?: boolean;
  email?: boolean;
  tokenIdentifier?: boolean;
};

/** Names of identity fields that can be attached to telemetry spans. */
export type AuthTelemetryIdentityField = keyof AuthTelemetryIdentityFields;

/**
 * Telemetry enrichment config for auth spans.
 *
 * Defaults to privacy-safe behavior with no identity fields attached.
 */
export type AuthTelemetryConfig = {
  /**
   * Whether to include no identity values, hashed values, or raw values.
   *
   * @defaultValue "none"
   */
  includeIdentity?: AuthTelemetryIdentityMode;
  /**
   * Opt-in identity fields to attach to telemetry spans.
   *
   * Ignored when `includeIdentity` is `"none"`.
   */
  identityFields?: AuthTelemetryIdentityFields;
  /**
   * Required when `includeIdentity` is `"hashed"`.
   *
   * Use this to provide an application-defined hashing strategy for
   * correlating auth spans without exposing raw identifiers.
   */
  hashIdentity?: (value: string, field: AuthTelemetryIdentityField) => string;
};

/**
 * Extracts the union of role ID strings from a permissions config.
 *
 * When `TPermissions` is defined, this resolves to the literal key union
 * of the `roles` record. Otherwise falls back to `string`.
 *
 * @typeParam TPermissions - The permissions config type, or `undefined`.
 *
 * @see {@link Grant}
 */
export type RoleId<TPermissions extends PermissionsConfig | undefined> = TPermissions extends {
  roles: infer TRoles extends Record<string, unknown>;
}
  ? keyof TRoles & string
  : string;

/**
 * Extracts the union of grant strings from a permissions config.
 *
 * When `TPermissions` is defined, this resolves to the literal union of the
 * top-level `grants` array plus all role grant array elements. Otherwise falls
 * back to `string`.
 *
 * @typeParam TPermissions - The permissions config type, or `undefined`.
 *
 * @see {@link RoleId}
 */
export type Grant<TPermissions extends PermissionsConfig | undefined> =
  TPermissions extends PermissionsConfig
    ?
        | (TPermissions extends { grants: readonly unknown[] }
            ? TPermissions["grants"][number] & string
            : never)
        | (TPermissions extends {
            roles: infer TRoles extends Record<string, { grants: readonly unknown[] }>;
          }
            ? TRoles[keyof TRoles]["grants"][number] & string
            : never)
    : string;

export type ConnectionHookProtocol = "oidc" | "saml" | "scim";

export type ConnectionHookProfile<
  TProtocol extends ConnectionHookProtocol = ConnectionHookProtocol,
> = TProtocol extends "oidc"
  ? OidcClaims
  : TProtocol extends "saml"
    ? SamlClaims
    : ScimRawAttributes;

/**
 * The config for the Convex Auth library, passed to `defineAuth`.
 */
export type ConvexAuthConfig<TExtend = {}> = {
  /**
   * A list of authentication provider configs.
   *
   * You can import existing configs from
   * `@robelest/convex-auth/providers/<provider-name>`
   */
  providers: AuthProviderConfig[];
  /**
   * HTTP path where Convex Auth mounts its protocol routes.
   *
   * Defaults to `/auth`. Provider callbacks, the JWT issuer, OAuth discovery,
   * and `auth.request.add(http)` all use this same path.
   */
  path?: string;
  connection?: {
    hooks?: {
      profileResolved?: (args: {
        protocol: ConnectionHookProtocol;
        connectionId?: string;
        profile: ConnectionHookProfile;
      }) => Awaitable<ConnectionHookProfile | void>;
      beforeProvision?: (args: {
        protocol: ConnectionHookProtocol;
        connectionId?: string;
        profile: ConnectionHookProfile;
      }) => Awaitable<ConnectionHookProfile | void>;
      afterProvision?: (args: {
        protocol: ConnectionHookProtocol;
        connectionId?: string;
        profile: ConnectionHookProfile;
        userId: string;
      }) => Awaitable<void>;
      /**
       * Gate linking a sign-in onto an EXISTING user. Called when an SSO
       * connection sign-in (`protocol: "oidc" | "saml"`) or a credentials
       * (password) sign-in (`protocol: "credentials"`) resolves to an existing
       * user by email. Return `false` to deny the attach (a new, separate user
       * is created instead). The `"credentials"` case lets apps refuse linking a
       * password account onto a user whose email was verified elsewhere, since
       * the password sign-up itself has not proven email ownership.
       */
      allowLink?: (args: {
        protocol: ConnectionHookProtocol | "credentials";
        connectionId?: string;
        profile: ConnectionHookProfile;
        userId: string;
      }) => Awaitable<boolean | void>;
    };
  };
  /**
   * Run this deployment as an OAuth 2.1 authorization server (for MCP clients and
   * other OAuth apps). Providing this block turns on the full server — discovery,
   * dynamic client registration, authorization-code + PKCE + refresh grants,
   * audience-bound tokens, and CORS. Omit it for no authorization server.
   */
  oauth?: {
    /**
     * Paths of the app's headless pages the authorization server redirects the
     * browser to. `consent` shows the requested access and approves it via
     * `auth.oauth.code.authorize`; `login` is where it sends an unauthenticated
     * user.
     */
    pages: {
      login: string;
      consent: string;
    };
  };
  /**
   * Auth component reference from `components.auth`.
   *
   * Core auth storage operations are executed through
   * the component API boundary.
   */
  component: AuthComponentApi;
  /**
   * Session configuration.
   */
  session?: {
    /**
     * How long can a user session last without the user reauthenticating.
     *
     * Defaults to 30 days.
     *
     * @defaultValue 2_592_000_000
     */
    totalDurationMs?: number;
    /**
     * How long can a user session last without the user being active.
     *
     * Defaults to 30 days.
     *
     * @defaultValue 2_592_000_000
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
     *
     * @defaultValue 3_600_000
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
     *
     * @defaultValue 10
     */
    maxFailedAttemptsPerHour?: number;
  };
  /**
   * Stream-backed lifecycle event handlers.
   *
   * Configure with `authEvents.handlers({ ... })` from
   * `@robelest/convex-auth/server`.
   */
  events?: AuthEventHandlerMap<TExtend>;
  /**
   * Application-defined permission model used by membership access checks.
   *
   * Use `definePermissions({ grants, roles })` from
   * `@robelest/convex-auth/permissions` to preserve literal role IDs and
   * grant strings.
   */
  permissions?: {
    grants?: readonly string[];
    roles: Record<
      string,
      {
        label?: string;
        grants: string[];
      }
    >;
  };
  /**
   * Optional OpenTelemetry enrichment for auth spans.
   *
   * Defaults to no identity attributes. Set `includeIdentity` to `"hashed"`
   * or `"raw"` to opt into richer correlation.
   */
  telemetry?: AuthTelemetryConfig;
};

/**
 * Union of all supported auth provider config types.
 *
 * Includes materialized provider configs plus optional config factories.
 */
export type AuthProviderConfig =
  | OAuthMaterializedConfig
  | ConvexCredentialsConfig
  | (() => ConvexCredentialsConfig)
  | EmailConfig
  | (() => EmailConfig)
  | PhoneConfig
  | (() => PhoneConfig)
  | PasskeyProviderConfig
  | (() => PasskeyProviderConfig)
  | TotpProviderConfig
  | (() => TotpProviderConfig)
  | DeviceProviderConfig
  | (() => DeviceProviderConfig)
  | ConnectionProviderConfig;

/**
 * Minimal config stored for the Connection provider at runtime.
 * No options — connection configuration is entirely per-tenant runtime state.
 */
export interface ConnectionProviderConfig {
  id: string;
  type: "connection";
  /**
   * Optional shared callback URI for all OIDC group connections.
   * When omitted, each connection gets its own callback path.
   */
  redirectURI?: string;
}

/**
 * Account linking strategy for group Connection sign-in.
 *
 * - `"sameConnection"` (default) — only link to a user already associated
 *   with **this** connection (via its account/externalId). Never link across
 *   IdPs by email. This prevents cross-IdP/tenant account takeover.
 * - `"verifiedEmail"` — link accounts when the IdP-provided email matches a
 *   verified email on an existing user. Opt-in; only safe when every
 *   connection that can assert this email is mutually trusted.
 * - `"none"` — never auto-link; always create a new account.
 */
type GroupConnectionAccountLinkingPolicy = "verifiedEmail" | "none" | "sameConnection";

/**
 * Policy for reusing existing users during SCIM provisioning.
 *
 * - `"externalId"` — match by the SCIM `externalId` to reuse a previously provisioned user.
 * - `"none"` — always create a new user for each SCIM provision request.
 */
type GroupConnectionScimReuseUserPolicy = "externalId" | "none";

/**
 * Just-in-time provisioning mode for group Connection.
 *
 * - `"off"` — no JIT provisioning; users must be pre-provisioned.
 * - `"createUser"` — create a user record on first Connection sign-in.
 * - `"createUserAndMembership"` — create a user and add them to the group on first Connection sign-in.
 */
type GroupConnectionJitProvisioningMode = "off" | "createUser" | "createUserAndMembership";

/**
 * Deprovisioning strategy when a SCIM user is deleted.
 *
 * - `"soft"` — mark the user as inactive but preserve the record.
 * - `"hard"` — permanently delete the user and associated data.
 */
type GroupConnectionDeprovisionMode = "soft" | "hard";

type GroupConnectionProfileUpdateMode = "never" | "missing" | "always";
type GroupConnectionProvisioningAuthority = "app" | "connection" | "scim";
type GroupConnectionGroupSyncMode = "ignore" | "sync";
type GroupConnectionRoleSyncMode = "ignore" | "map";

/**
 * Effective group policy document stored for an Connection/SCIM tenant.
 *
 * Controls account linking, JIT provisioning, SCIM reuse behavior,
 * deprovisioning, and any app-defined extension metadata.
 *
 * @see {@link GroupConnectionPolicyPatch}
 */
export interface GroupConnectionPolicy {
  version: 1;
  identity: {
    accountLinking: {
      oidc: GroupConnectionAccountLinkingPolicy;
      saml: GroupConnectionAccountLinkingPolicy;
    };
  };
  provisioning: {
    user: {
      createOnSignIn: boolean;
      updateProfileOnLogin: GroupConnectionProfileUpdateMode;
      updateProfileFromScim: GroupConnectionProfileUpdateMode;
      authority: GroupConnectionProvisioningAuthority;
    };
    scimReuse: {
      user: GroupConnectionScimReuseUserPolicy;
    };
    jit: {
      mode: GroupConnectionJitProvisioningMode;
      defaultRoleIds: string[];
    };
    deprovision: {
      mode: GroupConnectionDeprovisionMode;
    };
    groups: {
      mode: GroupConnectionGroupSyncMode;
      source: "protocol";
      mapping?: Record<string, string[]>;
    };
    roles: {
      mode: GroupConnectionRoleSyncMode;
      source: "protocol";
      mapping?: Record<string, string[]>;
    };
  };
  extend?: Record<string, unknown>;
}

/**
 * Partial update payload for {@link GroupConnectionPolicy}.
 *
 * Use this when patching only selected group policy sections without
 * replacing the entire stored policy document.
 */
export interface GroupConnectionPolicyPatch {
  identity?: {
    accountLinking?: {
      oidc?: GroupConnectionAccountLinkingPolicy;
      saml?: GroupConnectionAccountLinkingPolicy;
    };
  };
  provisioning?: {
    user?: {
      createOnSignIn?: boolean;
      updateProfileOnLogin?: GroupConnectionProfileUpdateMode;
      updateProfileFromScim?: GroupConnectionProfileUpdateMode;
      authority?: GroupConnectionProvisioningAuthority;
    };
    scimReuse?: {
      user?: GroupConnectionScimReuseUserPolicy;
    };
    jit?: {
      mode?: GroupConnectionJitProvisioningMode;
      defaultRoleIds?: string[];
    };
    deprovision?: {
      mode?: GroupConnectionDeprovisionMode;
    };
    groups?: {
      mode?: GroupConnectionGroupSyncMode;
      source?: "protocol";
      mapping?: Record<string, string[]>;
    };
    roles?: {
      mode?: GroupConnectionRoleSyncMode;
      source?: "protocol";
      mapping?: Record<string, string[]>;
    };
  };
  extend?: Record<string, unknown>;
}

/**
 * Email provider config for magic link / OTP sign-in.
 *
 * @typeParam DataModel - The Convex data model for typed action contexts.
 */
export interface EmailConfig<DataModel extends GenericDataModel = GenericDataModel> {
  /** Provider identifier (e.g. `"email"`, `"resend"`). */
  id: string;
  /** Discriminant for provider type routing. */
  type: "email";
  /** Display name for this provider. */
  name?: string;
  /** Sender address (e.g. `"My App <noreply@example.com>"`). */
  from?: string;
  /**
   * Token expiration in seconds. Defaults to 86 400 (24 hours).
   *
   * @defaultValue 86400
   */
  maxAge?: number;
  /**
   * Send the verification token to the user.
   *
   * Accepts an optional Convex action context as the second argument,
   * enabling use with Convex components like `@convex-dev/resend`.
   */
  sendVerificationRequest: (
    params: {
      identifier: string;
      url: string;
      expires: Date;
      provider: EmailConfig;
      token: string;
      request: Request;
    },
    ctx?: GenericActionCtx<AnyDataModel>,
  ) => Awaitable<void>;
  /**
   * Override to generate a custom verification token.
   * Tokens shorter than 24 characters are treated as OTPs and
   * require the original email to be re-submitted for verification.
   */
  generateVerificationToken?: () => Awaitable<string>;
  /**
   * Normalize the email address before storage / lookup.
   * Defaults to lowercasing and trimming whitespace.
   */
  normalizeIdentifier?: (identifier: string) => string;
  /**
   * Before the token is verified, check other
   * provided parameters.
   *
   * Used to make sure that OTPs are accompanied
   * with the correct email address.
   */
  authorize?: (
    /**
     * The values passed to the `signIn` function.
     */
    params: Record<string, Value | undefined>,
    account: GenericDoc<DataModel, "Account">,
  ) => Promise<void>;
  /** Raw user options before merging with defaults. */
  options: EmailUserConfig<DataModel>;
}

/**
 * User-facing configuration shape accepted by the email provider.
 *
 * Equivalent to `Partial<EmailConfig>` without internal runtime-only fields.
 *
 * @typeParam DataModel - The Convex data model.
 */
export type EmailUserConfig<DataModel extends GenericDataModel = GenericDataModel> = Omit<
  Partial<EmailConfig<DataModel>>,
  "options" | "type"
>;

/**
 * Same as email provider config, but verifies
 * phone number instead of the email address.
 *
 * @typeParam DataModel - The Convex data model for typed action contexts.
 */
export interface PhoneConfig<DataModel extends GenericDataModel = GenericDataModel> {
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
   * Defaults to `env.AUTH_<PROVIDER_ID>_KEY`.
   */
  apiKey?: string;
  /**
   * Override this to generate a custom token.
   * Note that the tokens are assumed to be cryptographically secure.
   * Any tokens shorter than 24 characters are assumed to not
   * be secure enough on their own, and require providing
   * the original `phone` used in the initial `signIn` call.
   *
   * @returns The verification token to send to the user.
   */
  generateVerificationToken?: () => Promise<string>;
  /**
   * Normalize the phone number.
   * @param identifier Passed as `phone` in params of `signIn`.
   * @returns The phone number used in `sendVerificationRequest`.
   */
  normalizeIdentifier?: (identifier: string) => string;
  /**
   * Before the token is verified, check other
   * provided parameters.
   *
   * Used to make sure tha OTPs are accompanied
   * with the correct phone number.
   */
  authorize?: (
    /**
     * The values passed to the `signIn` function.
     */
    params: Record<string, Value | undefined>,
    account: GenericDoc<DataModel, "Account">,
  ) => Promise<void>;
  options: PhoneUserConfig<DataModel>;
}

/**
 * User-facing configuration shape accepted by the phone provider.
 *
 * Equivalent to `Partial<PhoneConfig>` without internal runtime-only fields.
 *
 * @typeParam DataModel - The Convex data model.
 */
export type PhoneUserConfig<DataModel extends GenericDataModel = GenericDataModel> = Omit<
  Partial<PhoneConfig<DataModel>>,
  "options" | "type"
>;

/**
 * Credentials provider config used by Convex Auth.
 *
 * Extends the user-facing {@link CredentialsConfig} with the stable provider
 * `id` and `type` fields injected by the library.
 *
 * @typeParam DataModel - The Convex data model used by the auth context.
 */
export type ConvexCredentialsConfig<DataModel extends GenericDataModel = GenericDataModel> =
  CredentialsConfig<DataModel> & {
    type: "credentials";
    id: string;
  };

/**
 * Configuration for the passkey (WebAuthn) provider.
 */
export interface PasskeyProviderConfig {
  id: string;
  type: "passkey";
  options: {
    /** Relying Party display name. Defaults to APP_URL hostname. */
    rpName?: string;
    /** Relying Party ID (hostname). Defaults to APP_URL hostname. */
    rpId?: string;
    /** Allowed origins for credential verification. Defaults to APP_URL. */
    origin?: string | string[];
    /**
     * Attestation conveyance preference. Defaults to "none".
     *
     * @defaultValue "none"
     */
    attestation?: "none" | "direct";
    /**
     * User verification requirement. Defaults to "required".
     *
     * @defaultValue "required"
     */
    userVerification?: "required" | "preferred" | "discouraged";
    /**
     * Resident key (discoverable credential) preference. Defaults to "preferred".
     *
     * @defaultValue "preferred"
     */
    residentKey?: "required" | "preferred" | "discouraged";
    /** Restrict to platform or cross-platform authenticators. */
    authenticatorAttachment?: "platform" | "cross-platform";
    /**
     * Supported COSE algorithms. Defaults to [-7 (ES256), -257 (RS256)].
     *
     * @defaultValue [-7, -257]
     */
    algorithms?: number[];
    /**
     * Challenge expiration in ms. Defaults to 300_000 (5 minutes).
     *
     * @defaultValue 300_000
     */
    challengeExpirationMs?: number;
  };
}

/**
 * Configuration for the TOTP two-factor authentication provider.
 */
export interface TotpProviderConfig {
  id: string;
  type: "totp";
  options: {
    /** Issuer name shown in authenticator apps (e.g. "My App"). */
    issuer: string;
    /**
     * Number of digits in each code (default: 6).
     *
     * @defaultValue 6
     */
    digits: number;
    /**
     * Time period in seconds for code rotation (default: 30).
     *
     * @defaultValue 30
     */
    period: number;
  };
}

/**
 * Normalized user profile returned by an OAuth provider.
 *
 * `id` is the provider-specific account identifier (e.g. GitHub user ID).
 */
export interface ProfileEmail {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

export interface OAuthProfile {
  id: string;
  name?: string;
  email?: string;
  /**
   * All emails the provider reported (e.g. GitHub `/user/emails`). When
   * present, every entry is recorded; `email` remains the primary for
   * back-compat. Single-email providers omit this.
   */
  emails?: ProfileEmail[];
  image?: string;
  /** Additional claims from the ID token or userinfo endpoint. */
  [key: string]: unknown;
}

/**
 * Stable OAuth token shape exposed to provider callbacks.
 *
 * This contract is owned by convex-auth so users are insulated from changes
 * to the underlying OAuth implementation.
 */
export interface OAuthTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  scopes?: string[];
  raw?: unknown;
}

export interface OAuthRuntimeClient {
  readonly pkce: "required" | "optional" | "never";
  createAuthorizationURL(args: {
    state: string;
    codeVerifier?: string;
    scopes: string[];
    nonce?: string;
    loginHint?: string;
    redirectUri?: string;
  }): URL;
  validateAuthorizationCode(args: {
    code: string;
    codeVerifier?: string;
    redirectUri?: string;
  }): Promise<OAuthTokens>;
}

/** Credentials identifying a provider account (e.g. email + hashed password). */
type AuthAccountCredentials = {
  /** Provider-specific account identifier (e.g. email address). */
  id: string;
  /** Optional secret (e.g. hashed password). */
  secret?: string;
};

/** Arguments for `auth.account.create()`. */
type AuthCreateAccountArgs = {
  provider: string;
  account: AuthAccountCredentials;
  profile: Record<string, unknown> & {
    email?: string;
    phone?: string;
    emailVerified?: boolean;
    phoneVerified?: boolean;
  };
  shouldLinkViaEmail?: boolean;
  shouldLinkViaPhone?: boolean;
};

/** Arguments for `auth.account.get()`. */
type AuthRetrieveAccountArgs = {
  provider: string;
  account: AuthAccountCredentials;
};

/** Arguments for `auth.account.update()`. */
type AuthUpdateAccountArgs = {
  provider: string;
  account: {
    id: string;
    secret: string;
  };
};

/** Arguments for `auth.session.revoke()`. */
type AuthInvalidateSessionsArgs = {
  userId: GenericId<"User">;
  except?: GenericId<"Session">[];
};

/** Arguments for `auth.account.unlink()`. */
type AuthUnlinkAccountArgs = {
  accountId: GenericId<"Account">;
};

/** Arguments for `auth.passkey.remove()`. */
type AuthDeletePasskeyArgs = {
  passkeyId: GenericId<"Passkey">;
};

/** Arguments for `auth.totp.remove()`. */
type AuthDeleteTotpArgs = {
  totpId: GenericId<"TotpFactor">;
};

/** Arguments for `auth.provider.signIn()`. */
type AuthProviderSignInArgs = {
  accountId?: GenericId<"Account">;
  params?: Record<string, Value | undefined>;
};

type AuthProviderImmediateSignInResult = {
  userId: GenericId<"User">;
  sessionId: GenericId<"Session">;
};

type AuthProviderDeferredSignInResult = Exclude<SignInFlowResult<null>, { kind: "signedIn" }>;

/** Return type of `auth.provider.signIn()`. */
type AuthProviderSignInResult =
  | AuthProviderImmediateSignInResult
  | AuthProviderDeferredSignInResult
  | null;

/** Arguments for `auth.member.get()`. */
type AuthMemberInspectArgs = {
  userId: GenericId<"User">;
  groupId: GenericId<"Group">;
  ancestry?: boolean;
  maxDepth?: number;
};

/** Result of `auth.member.get()` — membership state and derived access details. */
export type AuthMemberInspectResult = {
  membership: GenericDoc<GenericDataModel, "GroupMember"> | null;
  roleIds: string[];
  grants: string[];
};

/** Arguments for `auth.member.assert()`. */
type AuthMemberAssertArgs = AuthMemberInspectArgs & {
  roleIds?: string[];
  grants?: string[];
};

/**
 * Server-side auth helper methods injected into `ctx.auth` within provider actions.
 *
 * Provides programmatic access to account management, session lifecycle,
 * membership resolution, and provider sign-in from within Convex actions
 * that use {@link GenericActionCtxWithAuthConfig}.
 *
 * @see {@link GenericActionCtxWithAuthConfig}
 *
 * @example
 * ```ts
 * // Inside a credentials provider's authorize callback:
 * const { account, user } = await ctx.auth.account.get(ctx, {
 *   provider: "password",
 *   account: { id: email },
 * });
 * ```
 */
type AuthServerHelpers = {
  /**
   * Account management: create, retrieve, update, and unlink
   * provider-linked accounts.
   */
  account: {
    create: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthCreateAccountArgs,
    ) => Promise<{
      account: GenericDoc<GenericDataModel, "Account">;
      user: GenericDoc<GenericDataModel, "User">;
    }>;
    get: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthRetrieveAccountArgs,
    ) => Promise<{
      account: GenericDoc<GenericDataModel, "Account">;
      user: GenericDoc<GenericDataModel, "User">;
    }>;
    update: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthUpdateAccountArgs,
    ) => Promise<{ accountId: GenericId<"Account"> }>;
    /**
     * Unlink (delete) a provider-linked account by ID and emit
     * `account.unlinked` with the captured `provider`.
     */
    unlink: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthUnlinkAccountArgs,
    ) => Promise<{
      accountId: GenericId<"Account">;
      userId: GenericId<"User">;
      provider: string;
    }>;
  };
  /** Passkey credential management exposed to provider authorize callbacks. */
  passkey: {
    /**
     * Delete a passkey credential by ID and fire the `passkeyRemoved`
     * lifecycle event with the owning `userId`.
     */
    remove: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthDeletePasskeyArgs,
    ) => Promise<{
      passkeyId: GenericId<"Passkey">;
      userId: GenericId<"User">;
    }>;
  };
  /** TOTP factor management exposed to provider authorize callbacks. */
  totp: {
    /**
     * Delete a TOTP factor by ID and fire the `totpRemoved` lifecycle
     * event.
     */
    remove: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthDeleteTotpArgs,
    ) => Promise<{
      totpId: GenericId<"TotpFactor">;
      userId: GenericId<"User">;
    }>;
  };
  session: {
    current: (ctx: {
      auth: GenericActionCtx<GenericDataModel>["auth"];
    }) => Promise<GenericId<"Session"> | null>;
    revoke: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthInvalidateSessionsArgs,
    ) => Promise<{
      userId: GenericId<"User">;
      except: GenericId<"Session">[];
    }>;
  };
  member: {
    get: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthMemberInspectArgs,
    ) => Promise<AuthMemberInspectResult>;
    assert: (
      ctx: GenericActionCtx<GenericDataModel>,
      args: AuthMemberAssertArgs,
    ) => Promise<AuthMemberInspectResult>;
  };
  provider: {
    signIn: (
      ctx: GenericActionCtx<GenericDataModel>,
      provider: AuthProviderConfig,
      args: AuthProviderSignInArgs,
    ) => Promise<AuthProviderSignInResult>;
  };
};

/**
 * Your `ActionCtx` enriched with `ctx.auth.config` field with
 * the config passed to `defineAuth`.
 *
 * @typeParam DataModel - The Convex data model.
 */
export type GenericActionCtxWithAuthConfig<DataModel extends GenericDataModel> =
  GenericActionCtx<DataModel> & {
    auth: GenericActionCtx<DataModel>["auth"] & {
      config: ConvexAuthMaterializedConfig;
    } & AuthServerHelpers;
  };

/**
 * The config for the Convex Auth library, passed to `defineAuth`,
 * with defaults and initialized providers.
 *
 * See {@link ConvexAuthConfig}
 */
export type ConvexAuthMaterializedConfig = {
  providers: AuthProviderMaterializedConfig[];
} & Pick<
  ConvexAuthConfig,
  | "component"
  | "path"
  | "session"
  | "jwt"
  | "signIn"
  | "permissions"
  | "connection"
  | "oauth"
  | "telemetry"
>;

/**
 * Maps SAML assertion attribute names to user profile fields.
 *
 * Use this to tell the Connection flow which SAML attributes correspond to
 * the user's subject identifier, email, and display name fields.
 */
export interface SAMLAttributeMapping {
  /** SAML attribute for the unique subject identifier (NameID). */
  subject?: string;
  /** SAML attribute for the user's email address. */
  email?: string;
  /** SAML attribute for the user's full display name. */
  name?: string;
  /** SAML attribute for the user's first / given name. */
  firstName?: string;
  /** SAML attribute for the user's last / family name. */
  lastName?: string;
  /** SAML attribute for the user's avatar or profile image URL. */
  image?: string;
  /** SAML attribute containing external group names. */
  groups?: string;
  /** SAML attribute containing external role names. */
  roles?: string;
}

interface ConnectionProfileMapping {
  subject?: string;
  email?: string;
  emailVerified?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  image?: string;
  phone?: string;
  active?: string;
  externalId?: string;
  groups?: string;
  roles?: string;
}

export interface OIDCClaimMapping extends Pick<
  ConnectionProfileMapping,
  "subject" | "email" | "emailVerified" | "name" | "image" | "groups" | "roles"
> {}

/**
 * Materialized OAuth provider config.
 */
export interface OAuthMaterializedConfig {
  /**
   * Provider identifier (e.g. `"google"`, `"github"`).
   * @readonly
   */
  readonly id: string;
  /**
   * Discriminant for provider type routing.
   * @readonly
   */
  readonly type: "oauth";
  /**
   * The runtime client used for the authorization code flow.
   * @readonly
   */
  readonly provider: OAuthRuntimeClient | null;
  /**
   * OAuth scopes to request.
   * @readonly
   */
  readonly scopes: string[];
  /**
   * User-provided profile extraction callback.
   * @readonly
   */
  readonly profile?: (tokens: OAuthTokens) => Promise<OAuthProfile>;
  /** Whether to issue and verify a nonce cookie during the callback flow. */
  readonly nonce?: boolean;
  /** Optional token validation hook after code exchange. */
  readonly validateTokens?: (tokens: OAuthTokens, ctx: { nonce?: string }) => Promise<void>;
  /**
   * Account-linking policy for OAuth identities. Defaults to verified email linking.
   * @readonly
   */
  readonly accountLinking?: "verifiedEmail" | "none" | "sameConnection";
  /**
   * On a returning OAuth sign-in (matching `(provider, providerAccountId)`),
   * refresh the user's `name` / `image` / `email` from the incoming profile.
   * Defaults to `true` to match Auth.js / Clerk conventions and Connection's
   * `policy.provisioning.user.updateProfileOnLogin` philosophy.
   *
   * Set to `false` when consumer apps own the canonical user profile and
   * don't want OAuth re-auth to overwrite hand-edited fields.
   * @readonly
   */
  readonly updateProfileOnLogin?: boolean;
}

/**
 * Device authorization provider config (RFC 8628).
 *
 * Enables input-constrained devices (CLIs, TVs, IoT) to authenticate
 * by displaying a short code that the user enters on a secondary device.
 */
export interface DeviceProviderConfig {
  id: string;
  type: "device";
  /** User code character set. Default: `"BCDFGHJKLMNPQRSTVWXZ"` (base-20, no vowels). */
  charset: string;
  /** User code length. Default: 8. */
  userCodeLength: number;
  /** Device code + user code lifetime in seconds. Default: 900 (15 min). */
  expiresIn: number;
  /** Minimum polling interval in seconds. Default: 5. */
  interval: number;
  /**
   * Base URL for the verification page (e.g. `"http://localhost:3000/device"`).
   *
   * This is where users go to enter the device code. If not provided,
   * falls back to `APP_URL + "/device"`.
   */
  verificationUri?: string;
}

/**
 * Materialized auth provider config — the fully resolved form stored at runtime.
 */
export type AuthProviderMaterializedConfig =
  | OAuthMaterializedConfig
  | EmailConfig
  | PhoneConfig
  | ConvexCredentialsConfig
  | PasskeyProviderConfig
  | TotpProviderConfig
  | DeviceProviderConfig
  | ConnectionProviderConfig;

export type HasPasskeyProvider<P extends AuthProviderConfig[]> =
  Extract<P[number], { type: "passkey" }> extends never ? false : true;

export type HasTotpProvider<P extends AuthProviderConfig[]> =
  Extract<P[number], { type: "totp" }> extends never ? false : true;

export type HasDeviceProvider<P extends AuthProviderConfig[]> =
  Extract<P[number], { type: "device" }> extends never ? false : true;

/**
 * A single scope entry stored per API key.
 * Uses a resource:action pattern for structured permissions.
 *
 * ```ts
 * { resource: "users", actions: ["read", "list"] }
 * ```
 */
export interface KeyScope {
  resource: string;
  actions: string[];
}

/**
 * Result of scope verification. Provides a `.can()` helper
 * for checking if a key has a specific permission.
 *
 * ```ts
 * const result = await auth.key.verify(ctx, { secret: rawKey });
 * if (result.scopes.can("users", "read")) {
 *   // authorized
 * }
 * ```
 */
export interface ScopeChecker {
  /** Check if the key has permission for a given resource:action. */
  can(resource: string, action: string): boolean;
  /** The raw scope entries from the key. */
  scopes: KeyScope[];
}

/**
 * An API key record as returned by `auth.key.list()` and `auth.key.get()`.
 *
 * This is the PUBLIC projection of the stored `ApiKey` document
 * (`Infer<vApiKeyDoc>`). The `auth.key.get` / `auth.key.list` facades
 * (`server/domains/key.ts`) strip the sensitive SHA-256 `hashedKey` (the
 * bearer-lookup hash) and the mutable `rateLimitState` (internal token-bucket
 * counters) before returning, so neither is ever exposed to callers. This type
 * reflects that redacted shape. `auth.key.verify` reads the full component
 * document directly and is unaffected.
 */
export interface KeyRecord {
  /** Document ID. */
  _id: string;
  /** Owner user ID. */
  userId: string;
  /** Display prefix (e.g. `"sk_abc1"`). Safe to show in UIs. */
  prefix: string;
  /** Human-readable name (e.g. "CI Pipeline"). */
  name: string;
  /** Resource:action permissions granted to this key. */
  scopes: KeyScope[];
  /** Per-key rate limit, if configured. */
  rateLimit?: { maxRequests: number; windowMs: number };
  /** Expiration timestamp (ms since epoch), or `undefined` for no expiry. */
  expiresAt?: number;
  /** Timestamp of last successful verification, or `undefined` if never used. */
  lastUsedAt?: number;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** `true` when the key has been revoked (soft-deleted). */
  revoked: boolean;
  /** Arbitrary app-specific extension blob attached to the key. */
  extend?: Record<string, unknown>;
}

/** Filter fields for `auth.user.list()`. All optional. */
export type UserWhere = {
  email?: string;
  phone?: string;
  isAnonymous?: boolean;
  name?: string;
};

/**
 * Sortable fields for `auth.user.list()`.
 *
 * Only index-backed fields are sortable: `_creationTime` (default index),
 * `email`, and `phone`. `name` is a filter-only field (see {@link UserWhere}) —
 * it has no index, so it is not a valid sort key.
 */
export type UserOrderBy = "_creationTime" | "email" | "phone";

/**
 * Context injected into `auth.request.action()` and `auth.request.route()` handlers.
 *
 * The handler's `ctx` receives these fields after Bearer token verification:
 *
 * ```ts
 * auth.request.route(http, {
 *   path: "/api/data",
 *   method: "GET",
 *   handler: async (ctx, request) => {
 *     ctx.key.userId;               // owner of the API key
 *     ctx.key.keyId;                // the key document ID
 *     ctx.key.scopes.can("data", "read"); // scope check
 *   },
 * });
 * ```
 */
export interface HttpKeyContext {
  key: {
    /** The user ID that owns the verified API key. */
    userId: string;
    /** The API key document ID. */
    keyId: string;
    /** Scope checker for the verified key's permissions. */
    scopes: ScopeChecker;
  };
}

/**
 * CORS configuration for Bearer-authenticated HTTP endpoints.
 */
export interface CorsConfig {
  /**
   * Allowed origins. Defaults to `APP_URL`. Pass `["*"]` to allow any origin.
   */
  origins?: string[];
  /** Allowed HTTP methods. Defaults to `"GET,POST,PUT,PATCH,DELETE,OPTIONS"`. */
  methods?: string;
  /** Allowed request headers. Defaults to `"Content-Type,Authorization"`. */
  headers?: string;
}

/**
 * Convex document from a given table.
 */
export type GenericDoc<
  DataModel extends GenericDataModel,
  TableName extends TableNamesInDataModel<DataModel>,
> = DocumentByName<DataModel, TableName> & {
  _id: GenericId<TableName>;
  _creationTime: number;
};

/**
 * @internal
 */
export type FunctionReferenceFromExport<Export> =
  Export extends RegisteredQuery<infer Visibility, infer Args, infer Output>
    ? FunctionReference<"query", Visibility, Args, ConvertReturnType<Output>>
    : Export extends RegisteredMutation<infer Visibility, infer Args, infer Output>
      ? FunctionReference<"mutation", Visibility, Args, ConvertReturnType<Output>>
      : Export extends RegisteredAction<infer Visibility, infer Args, infer Output>
        ? FunctionReference<"action", Visibility, Args, ConvertReturnType<Output>>
        : never;

type ConvertReturnType<T> = UndefinedToNull<Awaited<T>>;

type UndefinedToNull<T> = T extends void ? null : T;

/** Data model derived from the component schema. */
export type AuthDataModel = DataModelFromSchemaDefinition<typeof schema>;

/** Mutation context typed to the auth component's data model. */
export type MutationCtx = GenericMutationCtx<AuthDataModel>;

/** A document from any table in the auth component schema. */
export type Doc<T extends TableNamesInDataModel<AuthDataModel>> = GenericDoc<AuthDataModel, T>;

/** Session information returned after authentication. */
export type SessionInfo<TTokens = AuthTokens | null> = {
  userId: GenericId<"User">;
  sessionId: GenericId<"Session">;
  tokens: TTokens;
};

/** Canonical identity claims mirrored into access tokens for Convex auth. */
export type SessionTokenIdentityClaims = {
  subject: GenericId<"User">;
  sessionId: GenericId<"Session">;
  name?: string;
  email?: string;
  emailVerified?: boolean;
  picture?: string;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
};

/**
 * Cross-component user document shape inferred from the component validator.
 *
 * Used by internal typed wrappers (`queryUserById`, etc.) so server code stays
 * aligned with the component runtime contract. Not intended for consumer use —
 * consumers should use `UserDoc` (exported from
 * `@robelest/convex-auth/component`).
 *
 * @internal
 */
export type CrossComponentUserDoc = Infer<typeof vUserDoc>;

export type KeyDoc = Infer<typeof vApiKeyDoc>;
