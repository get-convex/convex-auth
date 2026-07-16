import { paginationResultValidator } from "convex/server";
import { type GenericId, v, type Validator, type VId, type VLiteral } from "convex/values";

import { AUTH_EVENT_KINDS, EVENT_CATEGORIES } from "../shared/event/kinds";

/**
 * Build a `v.union` of string-literal validators from a non-empty tuple,
 * preserving each literal in the inferred type (so `Infer<>` stays the precise
 * union, not `string`). Used to derive the event kind/category validators from
 * the shared taxonomy tuples.
 */
function vLiteralUnion<T extends string>(values: readonly [T, ...T[]]) {
  const literals = values.map((value) => v.literal(value)) as {
    [K in keyof T[]]: VLiteral<T>;
  } & [VLiteral<T>, ...VLiteral<T>[]];
  return v.union(...literals);
}

/** Table-name lookup map for the component's tables. */
export const TABLES = {
  User: "User",
  UserEmail: "UserEmail",
  Session: "Session",
  Account: "Account",
  AuthVerifier: "AuthVerifier",
  VerificationCode: "VerificationCode",
  RefreshToken: "RefreshToken",
  Passkey: "Passkey",
  TotpFactor: "TotpFactor",
  Group: "Group",
  GroupMember: "GroupMember",
  GroupInvite: "GroupInvite",
  GroupConnection: "GroupConnection",
  GroupConnectionDomain: "GroupConnectionDomain",
  SamlLoginRequest: "SamlLoginRequest",
  SamlSeenAssertion: "SamlSeenAssertion",
  GroupConnectionDomainVerification: "GroupConnectionDomainVerification",
  GroupConnectionSecret: "GroupConnectionSecret",
  GroupConnectionScimConfig: "GroupConnectionScimConfig",
  GroupConnectionScimIdentity: "GroupConnectionScimIdentity",
  GroupWebhookEndpoint: "GroupWebhookEndpoint",
  GroupWebhookDelivery: "GroupWebhookDelivery",
  ApiKey: "ApiKey",
  DeviceCode: "DeviceCode",
  OAuthClient: "OAuthClient",
  OAuthCode: "OAuthCode",
  OAuthRefreshGrant: "OAuthRefreshGrant",
  OAuthRefreshToken: "OAuthRefreshToken",
  AuthEventProjection: "AuthEventProjection",
} as const;

/**
 * Convex-native pagination return shape — matches `PaginationResult<T>` from
 * `convex/server`. Consumers can pass these queries directly to
 * `usePaginatedQuery` without any client-side adaptation.
 */
export const vPaginated = <V extends Validator<any, any, any>>(item: V) =>
  paginationResultValidator(item);

/** Lifecycle status of a group invite. */
export const vInviteStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("revoked"),
  v.literal("expired"),
);

/** Authorization status of an OAuth device-code flow. */
export const vDeviceStatus = v.union(
  v.literal("pending"),
  v.literal("authorized"),
  v.literal("denied"),
);

/**
 * How an OAuth client authenticates at the token endpoint (RFC 7591 §2). A
 * `none` client is public (no secret; PKCE is the proof); the others are
 * confidential and present a `client_secret`.
 */
export const vTokenEndpointAuthMethod = v.union(
  v.literal("client_secret_basic"),
  v.literal("client_secret_post"),
  v.literal("none"),
);

/** Policy for linking an incoming connection login to an existing account. */
export const vGroupConnectionAccountLinkingPolicy = v.union(
  v.literal("verifiedEmail"),
  v.literal("none"),
  v.literal("sameConnection"),
);

const vGroupConnectionScimReuseUserPolicy = v.union(v.literal("externalId"), v.literal("none"));

const vGroupConnectionJitProvisioningMode = v.union(
  v.literal("off"),
  v.literal("createUser"),
  v.literal("createUserAndMembership"),
);

const vGroupConnectionDeprovisionMode = v.union(v.literal("soft"), v.literal("hard"));

/** When to refresh a user's profile fields from connection data on login. */
export const vGroupConnectionProfileUpdateMode = v.union(
  v.literal("never"),
  v.literal("missing"),
  v.literal("always"),
);

const vGroupConnectionProvisioningAuthority = v.union(
  v.literal("app"),
  v.literal("connection"),
  v.literal("scim"),
);

const vGroupConnectionGroupSyncMode = v.union(v.literal("ignore"), v.literal("sync"));

const vGroupConnectionRoleSyncMode = v.union(v.literal("ignore"), v.literal("map"));

/** Lifecycle status of a group SSO connection. */
export const vGroupConnectionStatus = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("disabled"),
);

/** SSO protocol used by a group connection. */
export const vGroupConnectionProtocol = v.union(v.literal("oidc"), v.literal("saml"));

/** Identity-linking and provisioning policy for a group connection. */
export const vGroupConnectionPolicy = v.object({
  version: v.literal(1),
  identity: v.object({
    accountLinking: v.object({
      oidc: vGroupConnectionAccountLinkingPolicy,
      saml: vGroupConnectionAccountLinkingPolicy,
    }),
  }),
  provisioning: v.object({
    user: v.object({
      createOnSignIn: v.boolean(),
      updateProfileOnLogin: vGroupConnectionProfileUpdateMode,
      updateProfileFromScim: vGroupConnectionProfileUpdateMode,
      authority: vGroupConnectionProvisioningAuthority,
    }),
    scimReuse: v.object({
      user: vGroupConnectionScimReuseUserPolicy,
    }),
    jit: v.object({
      mode: vGroupConnectionJitProvisioningMode,
      defaultRole: v.optional(v.string()),
      defaultRoleIds: v.optional(v.array(v.string())),
    }),
    deprovision: v.object({
      mode: vGroupConnectionDeprovisionMode,
    }),
    groups: v.object({
      mode: vGroupConnectionGroupSyncMode,
      source: v.literal("protocol"),
      mapping: v.optional(v.record(v.string(), v.array(v.string()))),
    }),
    roles: v.object({
      mode: vGroupConnectionRoleSyncMode,
      source: v.literal("protocol"),
      mapping: v.optional(v.record(v.string(), v.array(v.string()))),
    }),
  }),
  extend: v.optional(v.any()),
});

/** Lifecycle status of a SCIM provisioning configuration. */
export const vScimStatus = v.union(v.literal("draft"), v.literal("active"), v.literal("disabled"));

/** SCIM resource type being provisioned. */
export const vScimResourceType = v.union(v.literal("user"), v.literal("group"));

/** Whether a webhook endpoint is accepting deliveries. */
export const vWebhookEndpointStatus = v.union(v.literal("active"), v.literal("disabled"));

/** Delivery state of a queued webhook event. */
export const vWebhookDeliveryStatus = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("delivered"),
  v.literal("failed"),
);

/** Kind of entity an auth event is indexed against. */
export const vAuthEventTargetKind = v.union(
  v.literal("user"),
  v.literal("session"),
  v.literal("group"),
  v.literal("connection"),
  v.literal("oauth_client"),
  v.literal("api_key"),
  v.literal("global"),
);

/**
 * High-level category grouping for an auth event. Derived from the shared
 * {@link EVENT_CATEGORIES} taxonomy so the validator and the `AuthEventCategory`
 * TS union stay in lockstep.
 */
export const vAuthEventCategory = vLiteralUnion(EVENT_CATEGORIES);

/**
 * Discriminator naming the specific auth event that occurred. Derived from the
 * shared {@link AUTH_EVENT_KINDS} taxonomy — the single source of truth for the
 * event kind set shared with the server facade.
 */
export const vAuthEventKind = vLiteralUnion(AUTH_EVENT_KINDS);

/** Type of principal that triggered an auth event. */
export const vAuthEventActorType = v.union(
  v.literal("user"),
  v.literal("system"),
  v.literal("scim"),
  v.literal("api_key"),
  v.literal("oauth_client"),
  v.literal("webhook"),
  v.literal("anonymous"),
);

/** Type of entity an auth event acted upon. */
export const vAuthEventSubjectType = v.union(
  v.literal("user"),
  v.literal("session"),
  v.literal("account"),
  v.literal("passkey"),
  v.literal("totp"),
  v.literal("email"),
  v.literal("phone"),
  v.literal("api_key"),
  v.literal("oauth_client"),
  v.literal("oauth_code"),
  v.literal("group"),
  v.literal("connection"),
  v.literal("scim_identity"),
  v.literal("webhook_endpoint"),
  v.literal("webhook_delivery"),
  v.literal("system"),
);

/** Whether the action behind an auth event succeeded or failed. */
export const vAuthEventOutcome = v.union(v.literal("success"), v.literal("failure"));

const vAuthEventStringArray = v.array(v.string());
const vAuthExternalObject = v.record(v.string(), v.any());

/** Discriminated union of per-kind auth-event payload shapes. */
export const vAuthEventData = v.union(
  v.object({
    type: v.optional(v.string()),
    provider: v.optional(v.string()),
    profile: v.optional(vAuthExternalObject),
    existingUserId: v.optional(v.string()),
  }),
  v.object({
    provider: v.string(),
    method: v.optional(v.string()),
  }),
  v.object({
    userId: v.optional(v.string()),
    reason: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    refreshTokenId: v.optional(v.string()),
    flow: v.optional(v.union(v.literal("reset"), v.literal("change"))),
  }),
  v.object({
    provider: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    accountId: v.optional(v.string()),
  }),
  v.object({
    passkeyId: v.optional(v.string()),
    credentialId: v.optional(v.string()),
    totpId: v.optional(v.string()),
    keyId: v.optional(v.string()),
    name: v.optional(v.string()),
    prefix: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
  v.object({
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    userId: v.optional(v.string()),
  }),
  v.object({
    clientId: v.optional(v.string()),
    codeId: v.optional(v.string()),
    name: v.optional(v.string()),
    scopes: v.optional(vAuthEventStringArray),
    redirectUri: v.optional(v.string()),
    grantType: v.optional(v.string()),
    resource: v.optional(v.string()),
    userId: v.optional(v.string()),
  }),
  v.object({
    connectionId: v.optional(v.string()),
    changed: v.optional(vAuthEventStringArray),
    userId: v.optional(v.string()),
    protocol: v.optional(v.union(v.literal("oidc"), v.literal("saml"))),
    domain: v.optional(v.string()),
    recordName: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    metadataUrl: v.optional(v.string()),
    domains: v.optional(vAuthEventStringArray),
    issuer: v.optional(v.string()),
    discoveryUrl: v.optional(v.string()),
    jwksUri: v.optional(v.string()),
    audience: v.optional(v.union(v.string(), vAuthEventStringArray)),
    tokenEndpointAuthMethod: v.optional(v.string()),
    version: v.optional(v.number()),
    errorCode: v.optional(v.string()),
  }),
  v.object({
    scimConfigId: v.optional(v.string()),
    resourceType: v.optional(v.union(v.literal("user"), v.literal("group"))),
    resourceId: v.optional(v.string()),
    operation: v.optional(v.string()),
    externalId: v.optional(v.string()),
    active: v.optional(v.boolean()),
    groupId: v.optional(v.string()),
    userId: v.optional(v.string()),
  }),
  v.object({
    endpointId: v.optional(v.string()),
    deliveryId: v.optional(v.string()),
    sourceEventId: v.optional(v.string()),
    sourceEventType: v.optional(vAuthEventKind),
    attemptCount: v.optional(v.number()),
    status: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
);

/** Entity an auth event is indexed against (kind plus id). */
export const vAuthEventTarget = v.object({
  kind: vAuthEventTargetKind,
  id: v.string(),
});

/** Principal that triggered an auth event (type plus optional id). */
export const vAuthEventActor = v.object({
  type: vAuthEventActorType,
  id: v.optional(v.string()),
});

/** Entity an auth event acted upon (type plus optional id). */
export const vAuthEventSubject = v.object({
  type: vAuthEventSubjectType,
  id: v.optional(v.string()),
});

/** Request metadata captured alongside an auth event. */
export const vAuthEventRequest = v.object({
  requestId: v.optional(v.string()),
  ip: v.optional(v.string()),
  userAgent: v.optional(v.string()),
});

/** A complete auth event as appended to the event log. */
export const vAuthEvent = v.object({
  eventId: v.string(),
  kind: vAuthEventKind,
  category: vAuthEventCategory,
  occurredAt: v.number(),
  actor: vAuthEventActor,
  subject: vAuthEventSubject,
  targets: v.array(vAuthEventTarget),
  request: v.optional(vAuthEventRequest),
  outcome: vAuthEventOutcome,
  errorCode: v.optional(v.string()),
  data: v.optional(vAuthEventData),
});

/** Filter selector for querying auth-event projections. */
export const vAuthEventWhere = v.object({
  target: v.optional(vAuthEventTarget),
  kind: v.optional(vAuthEventKind),
  category: v.optional(vAuthEventCategory),
  outcome: v.optional(vAuthEventOutcome),
  actor: v.optional(vAuthEventActor),
  subject: v.optional(vAuthEventSubject),
  requestId: v.optional(v.string()),
  occurredAtGte: v.optional(v.number()),
  occurredAtGt: v.optional(v.number()),
  occurredAtLte: v.optional(v.number()),
  occurredAtLt: v.optional(v.number()),
});

const vInviteTokenAcceptStatus = v.union(v.literal("accepted"), v.literal("already_accepted"));

const vMembershipStatus = v.union(
  v.literal("joined"),
  v.literal("already_joined"),
  v.literal("not_applicable"),
);

/** A resource plus the actions an API key is permitted on it. */
export const vApiKeyScope = v.object({
  resource: v.string(),
  actions: v.array(v.string()),
});

/** Rate-limit configuration for an API key (requests per window). */
export const vApiKeyRateLimit = v.object({
  maxRequests: v.number(),
  windowMs: v.number(),
});

/** Mutable rate-limit counters tracked for an API key. */
export const vApiKeyRateLimitState = v.object({
  attemptsLeft: v.number(),
  lastAttemptTime: v.number(),
});

/** Kind of encrypted secret stored for a group connection. */
export const vGroupConnectionSecretKind = v.union(v.literal("oidc_client_secret"));

function vDocMeta<T extends (typeof TABLES)[keyof typeof TABLES]>(tableName: T) {
  return {
    _id: v.id(tableName),
    _creationTime: v.number(),
  };
}

/**
 * The shape of `v.id` — and any drop-in replacement that needs to type-claim
 * `Id<T>` while choosing a different runtime validator (e.g. `v.string()` for
 * cross-component boundaries where the consumer's data model lacks the
 * component's table tags).
 */
export type IdValidatorFn = <T extends string>(table: T) => VId<GenericId<T>, "required">;

/**
 * Field maps for the five documents that cross the component boundary.
 *
 * Each builder takes the ID validator function as its only parameter and
 * is called twice in the codebase: once with `v.id` here (strict —
 * component-internal `vUserDoc` etc.), and once with `vIdString` over in
 * `server/validators.ts` (permissive — the `auth.v.*` consumer-facing
 * validators that need to accept component-issued IDs after they cross the
 * component boundary).
 *
 * Each builder is generic over the ID-validator function so each call site
 * preserves its concrete return type. Without `<F extends IdValidatorFn>`
 * TypeScript collapses `Infer<…>._id` to a single shared inference.
 */
export const userFields = <F extends IdValidatorFn>(vId: F) => ({
  _id: vId(TABLES.User),
  _creationTime: v.number(),
  name: v.optional(v.string()),
  image: v.optional(v.string()),
  email: v.optional(v.string()),
  emailVerificationTime: v.optional(v.number()),
  phone: v.optional(v.string()),
  phoneVerificationTime: v.optional(v.number()),
  isAnonymous: v.optional(v.boolean()),
  lastActiveGroup: v.optional(vId(TABLES.Group)),
  hasTotp: v.optional(v.boolean()),
  extend: v.optional(v.any()),
});

/** Shared field validators for `UserEmail` documents, parameterized by the id-validator factory. */
export const emailFields = <F extends IdValidatorFn>(vId: F) => ({
  _id: vId(TABLES.UserEmail),
  _creationTime: v.number(),
  userId: vId(TABLES.User),
  email: v.string(),
  verificationTime: v.optional(v.number()),
  isPrimary: v.boolean(),
  source: vUserEmailSource,
  accountId: v.optional(vId(TABLES.Account)),
  provider: v.optional(v.string()),
  connectionId: v.optional(vId(TABLES.GroupConnection)),
});

/** Shared field validators for `Group` documents, parameterized by the id-validator factory. */
export const groupFields = <F extends IdValidatorFn>(vId: F) => ({
  _id: vId(TABLES.Group),
  _creationTime: v.number(),
  name: v.string(),
  slug: v.optional(v.string()),
  type: v.optional(v.string()),
  parentGroupId: v.optional(vId(TABLES.Group)),
  rootGroupId: v.optional(vId(TABLES.Group)),
  isRoot: v.optional(v.boolean()),
  policy: v.optional(vGroupConnectionPolicy),
  extend: v.optional(v.any()),
});

/** Shared field validators for `GroupMember` documents, parameterized by the id-validator factory. */
export const memberFields = <F extends IdValidatorFn>(vId: F) => ({
  _id: vId(TABLES.GroupMember),
  _creationTime: v.number(),
  groupId: vId(TABLES.Group),
  userId: vId(TABLES.User),
  role: v.optional(v.string()),
  roleIds: v.optional(v.array(v.string())),
  status: v.optional(v.string()),
  extend: v.optional(v.any()),
});

/** Shared field validators for `GroupInvite` documents, parameterized by the id-validator factory. */
export const inviteFields = <F extends IdValidatorFn>(vId: F) => ({
  _id: vId(TABLES.GroupInvite),
  _creationTime: v.number(),
  groupId: v.optional(vId(TABLES.Group)),
  invitedByUserId: v.optional(vId(TABLES.User)),
  email: v.optional(v.string()),
  tokenHash: v.string(),
  role: v.optional(v.string()),
  roleIds: v.optional(v.array(v.string())),
  status: vInviteStatus,
  expiresTime: v.optional(v.number()),
  acceptedByUserId: v.optional(vId(TABLES.User)),
  acceptedTime: v.optional(v.number()),
  extend: v.optional(v.any()),
});

/** Validator for a `User` document. */
export const vUserDoc = v.object(userFields(v.id));

/** Origin that contributed a user's email address. */
export const vUserEmailSource = v.union(
  v.literal("password"),
  v.literal("oauth"),
  v.literal("oidc"),
  v.literal("saml"),
  v.literal("scim"),
);

/** An email entry within a provider profile. */
export const vProfileEmail = v.object({
  email: v.string(),
  primary: v.optional(v.boolean()),
  verified: v.optional(v.boolean()),
});

/** Validator for a `UserEmail` document. */
export const vUserEmailDoc = v.object(emailFields(v.id));

/** Validator for a `Session` document. */
export const vSessionDoc = v.object({
  ...vDocMeta(TABLES.Session),
  userId: v.id(TABLES.User),
  expirationTime: v.number(),
});

/** Validator for an `Account` document. */
export const vAccountDoc = v.object({
  ...vDocMeta(TABLES.Account),
  userId: v.id(TABLES.User),
  provider: v.string(),
  providerAccountId: v.string(),
  secret: v.optional(v.string()),
  emailVerified: v.optional(v.string()),
  phoneVerified: v.optional(v.string()),
  extend: v.optional(v.any()),
});

/** Validator for an `AuthVerifier` document. */
export const vAuthVerifierDoc = v.object({
  ...vDocMeta(TABLES.AuthVerifier),
  sessionId: v.optional(v.id(TABLES.Session)),
  signature: v.optional(v.string()),
  expirationTime: v.optional(v.number()),
});

/** Validator for a `VerificationCode` document. */
export const vVerificationCodeDoc = v.object({
  ...vDocMeta(TABLES.VerificationCode),
  accountId: v.id(TABLES.Account),
  provider: v.string(),
  code: v.string(),
  expirationTime: v.number(),
  verifier: v.optional(v.string()),
  emailVerified: v.optional(v.string()),
  phoneVerified: v.optional(v.string()),
});

/** Validator for a `RefreshToken` document. */
export const vRefreshTokenDoc = v.object({
  ...vDocMeta(TABLES.RefreshToken),
  sessionId: v.id(TABLES.Session),
  expirationTime: v.number(),
  firstUsedTime: v.optional(v.number()),
  parentRefreshTokenId: v.optional(v.id(TABLES.RefreshToken)),
});

/** Validator for a `Passkey` document. */
export const vPasskeyDoc = v.object({
  ...vDocMeta(TABLES.Passkey),
  userId: v.id(TABLES.User),
  credentialId: v.string(),
  publicKey: v.bytes(),
  algorithm: v.number(),
  counter: v.number(),
  transports: v.optional(v.array(v.string())),
  deviceType: v.string(),
  backedUp: v.boolean(),
  name: v.optional(v.string()),
  createdAt: v.number(),
  lastUsedAt: v.optional(v.number()),
});

/** Validator for a `TotpFactor` document. */
export const vTotpFactorDoc = v.object({
  ...vDocMeta(TABLES.TotpFactor),
  userId: v.id(TABLES.User),
  secret: v.bytes(),
  digits: v.number(),
  period: v.number(),
  verified: v.boolean(),
  name: v.optional(v.string()),
  createdAt: v.number(),
  lastUsedAt: v.optional(v.number()),
});

/** Validator for a `Group` document. */
export const vGroupDoc = v.object(groupFields(v.id));

/** Validator for a `GroupMember` document. */
export const vGroupMemberDoc = v.object(memberFields(v.id));

/** Validator for a `GroupInvite` document. */
export const vGroupInviteDoc = v.object(inviteFields(v.id));

/** Validator for an `ApiKey` document. */
export const vApiKeyDoc = v.object({
  ...vDocMeta(TABLES.ApiKey),
  userId: v.id(TABLES.User),
  prefix: v.string(),
  hashedKey: v.string(),
  name: v.string(),
  scopes: v.array(vApiKeyScope),
  rateLimit: v.optional(vApiKeyRateLimit),
  rateLimitState: v.optional(vApiKeyRateLimitState),
  expiresAt: v.optional(v.number()),
  lastUsedAt: v.optional(v.number()),
  createdAt: v.number(),
  revoked: v.boolean(),
  extend: v.optional(v.any()),
});

/** Validator for an `OAuthClient` document. */
export const vOAuthClientDoc = v.object({
  ...vDocMeta(TABLES.OAuthClient),
  clientId: v.string(),
  clientSecretHash: v.optional(v.string()),
  name: v.string(),
  redirectUris: v.array(v.string()),
  scopes: v.array(v.string()),
  grantTypes: v.array(v.string()),
  tokenEndpointAuthMethod: v.optional(vTokenEndpointAuthMethod),
  registrationAccessTokenHash: v.optional(v.string()),
  createdBy: v.optional(v.id(TABLES.User)),
  revoked: v.boolean(),
  extend: v.optional(v.any()),
});

/** Validator for an `OAuthCode` document. */
export const vOAuthCodeDoc = v.object({
  ...vDocMeta(TABLES.OAuthCode),
  codeHash: v.string(),
  userId: v.id(TABLES.User),
  clientId: v.string(),
  redirectUri: v.string(),
  scopes: v.array(v.string()),
  codeChallenge: v.string(),
  resource: v.optional(v.string()),
  expiresAt: v.number(),
  usedAt: v.optional(v.number()),
});

/** Validator for an `OAuthRefreshGrant` document (the rotation-chain root). */
export const vOAuthRefreshGrantDoc = v.object({
  ...vDocMeta(TABLES.OAuthRefreshGrant),
  clientId: v.string(),
  userId: v.id(TABLES.User),
  scopes: v.array(v.string()),
  resource: v.optional(v.string()),
  expiresAt: v.number(),
  revokedAt: v.optional(v.number()),
});

/** Validator for an `OAuthRefreshToken` document (a leaf of a grant's chain). */
export const vOAuthRefreshTokenDoc = v.object({
  ...vDocMeta(TABLES.OAuthRefreshToken),
  tokenHash: v.string(),
  grantId: v.optional(v.id(TABLES.OAuthRefreshGrant)),
  expiresAt: v.number(),
  firstUsedTime: v.optional(v.number()),
  parentTokenId: v.optional(v.id(TABLES.OAuthRefreshToken)),
});

/** Validator for a `DeviceCode` document. */
export const vDeviceCodeDoc = v.object({
  ...vDocMeta(TABLES.DeviceCode),
  deviceCodeHash: v.string(),
  userCode: v.string(),
  expiresAt: v.number(),
  interval: v.number(),
  status: vDeviceStatus,
  userId: v.optional(v.id(TABLES.User)),
  sessionId: v.optional(v.id(TABLES.Session)),
  lastPolledAt: v.optional(v.number()),
});

/** Validator for a `GroupConnection` document. */
export const vGroupConnectionDoc = v.object({
  ...vDocMeta(TABLES.GroupConnection),
  groupId: v.id(TABLES.Group),
  slug: v.optional(v.string()),
  name: v.optional(v.string()),
  protocol: vGroupConnectionProtocol,
  status: vGroupConnectionStatus,
  config: v.optional(v.any()),
  extend: v.optional(v.any()),
});

/** Validator for a `GroupConnectionDomain` document. */
export const vGroupConnectionDomainDoc = v.object({
  ...vDocMeta(TABLES.GroupConnectionDomain),
  connectionId: v.id(TABLES.GroupConnection),
  groupId: v.id(TABLES.Group),
  domain: v.string(),
  isPrimary: v.boolean(),
  verifiedAt: v.optional(v.number()),
});

/** Validator for a `SamlLoginRequest` document. */
export const vSamlLoginRequestDoc = v.object({
  ...vDocMeta(TABLES.SamlLoginRequest),
  connectionId: v.id(TABLES.GroupConnection),
  requestId: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
  acceptedAt: v.optional(v.number()),
});

/** Validator for a `SamlSeenAssertion` document. */
export const vSamlSeenAssertionDoc = v.object({
  ...vDocMeta(TABLES.SamlSeenAssertion),
  connectionId: v.id(TABLES.GroupConnection),
  assertionId: v.string(),
  expiresAt: v.number(),
});

/** Validator for a `GroupConnectionDomainVerification` document. */
export const vGroupConnectionDomainVerificationDoc = v.object({
  ...vDocMeta(TABLES.GroupConnectionDomainVerification),
  connectionId: v.id(TABLES.GroupConnection),
  groupId: v.id(TABLES.Group),
  domainId: v.id(TABLES.GroupConnectionDomain),
  domain: v.string(),
  recordName: v.string(),
  token: v.string(),
  tokenHash: v.string(),
  requestedAt: v.number(),
  expiresAt: v.number(),
});

/** Validator for a `GroupConnectionSecret` document. */
export const vGroupConnectionSecretDoc = v.object({
  ...vDocMeta(TABLES.GroupConnectionSecret),
  connectionId: v.id(TABLES.GroupConnection),
  groupId: v.id(TABLES.Group),
  kind: vGroupConnectionSecretKind,
  ciphertext: v.string(),
  updatedAt: v.number(),
});

/** Validator for a `GroupConnectionScimConfig` document. */
export const vGroupConnectionScimConfigDoc = v.object({
  ...vDocMeta(TABLES.GroupConnectionScimConfig),
  connectionId: v.id(TABLES.GroupConnection),
  groupId: v.id(TABLES.Group),
  status: vScimStatus,
  basePath: v.string(),
  tokenHash: v.string(),
  lastRotatedAt: v.optional(v.number()),
  extend: v.optional(v.any()),
});

/** Validator for a `GroupConnectionScimIdentity` document. */
export const vGroupConnectionScimIdentityDoc = v.object({
  ...vDocMeta(TABLES.GroupConnectionScimIdentity),
  connectionId: v.id(TABLES.GroupConnection),
  groupId: v.id(TABLES.Group),
  resourceType: vScimResourceType,
  externalId: v.string(),
  userId: v.optional(v.id(TABLES.User)),
  mappedGroupId: v.optional(v.id(TABLES.Group)),
  lastProvisionedAt: v.optional(v.number()),
  active: v.optional(v.boolean()),
  raw: v.optional(v.any()),
});

/** Validator for an `AuthEventProjection` document. */
export const vAuthEventProjectionDoc = v.object({
  ...vDocMeta(TABLES.AuthEventProjection),
  eventId: v.string(),
  targetKind: vAuthEventTargetKind,
  targetId: v.string(),
  kind: vAuthEventKind,
  category: vAuthEventCategory,
  occurredAt: v.number(),
  actorType: vAuthEventActorType,
  actorId: v.optional(v.string()),
  subjectType: vAuthEventSubjectType,
  subjectId: v.optional(v.string()),
  outcome: vAuthEventOutcome,
  errorCode: v.optional(v.string()),
  requestId: v.optional(v.string()),
  ip: v.optional(v.string()),
  data: v.optional(vAuthEventData),
});

/** Validator for a `GroupWebhookEndpoint` document. */
export const vGroupWebhookEndpointDoc = v.object({
  ...vDocMeta(TABLES.GroupWebhookEndpoint),
  connectionId: v.id(TABLES.GroupConnection),
  groupId: v.id(TABLES.Group),
  url: v.string(),
  status: vWebhookEndpointStatus,
  secretCiphertext: v.string(),
  subscriptions: v.array(vAuthEventKind),
  createdByUserId: v.optional(v.id(TABLES.User)),
  lastSuccessAt: v.optional(v.number()),
  lastFailureAt: v.optional(v.number()),
  failureCount: v.number(),
  extend: v.optional(v.any()),
});

/** Validator for a `GroupWebhookDelivery` document. */
export const vGroupWebhookDeliveryDoc = v.object({
  ...vDocMeta(TABLES.GroupWebhookDelivery),
  connectionId: v.id(TABLES.GroupConnection),
  endpointId: v.id(TABLES.GroupWebhookEndpoint),
  eventId: v.string(),
  kind: vAuthEventKind,
  status: vWebhookDeliveryStatus,
  attemptCount: v.number(),
  nextAttemptAt: v.number(),
  lastAttemptAt: v.optional(v.number()),
  lastResponseStatus: v.optional(v.number()),
  lastError: v.optional(v.string()),
  payload: v.any(),
  signature: v.string(),
  signedAt: v.number(),
});

/** Validator for the public (redacted) projection of a `GroupWebhookDelivery` document. */
export const vGroupWebhookDeliveryPublicDoc = v.object({
  ...vDocMeta(TABLES.GroupWebhookDelivery),
  connectionId: v.id(TABLES.GroupConnection),
  endpointId: v.id(TABLES.GroupWebhookEndpoint),
  eventId: v.string(),
  kind: vAuthEventKind,
  status: vWebhookDeliveryStatus,
  attemptCount: v.number(),
  nextAttemptAt: v.number(),
  lastAttemptAt: v.optional(v.number()),
  lastResponseStatus: v.optional(v.number()),
  lastError: v.optional(v.string()),
  signedAt: v.number(),
});

/** Summary returned after accepting an invite token: the invite plus resulting group/membership state. */
export const vInviteAcceptResult = v.object({
  inviteId: v.id(TABLES.GroupInvite),
  groupId: v.union(v.id(TABLES.Group), v.null()),
  memberId: v.optional(v.id(TABLES.GroupMember)),
  inviteStatus: vInviteTokenAcceptStatus,
  membershipStatus: vMembershipStatus,
});
