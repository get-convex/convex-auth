/**
 * Public Convex `returns:` validators for the auth read surface.
 *
 * These back the `auth.v` namespace on the {@link defineAuth} result.
 * Consumers set them as their function `returns:` so client-side
 * `useQuery` inference flows end-to-end with zero hand-rolled validators
 * or DTO mappers. The `extend` field on User/Group/GroupMember is
 * replaced with the validator the consumer supplied via
 * `defineAuth({ extend: { ... } })`, so `viewer.extend.<field>` is fully
 * typed instead of `any`.
 *
 * @module
 */

import { type GenericId, type Infer, v, type VId, type Validator } from "convex/values";

import {
  vAuthEventActorType,
  vAuthEventCategory,
  vAuthEventData,
  vAuthEventKind,
  vAuthEventOutcome,
  vAuthEventSubjectType,
  vAuthEventTargetKind,
  emailFields,
  groupFields,
  type IdValidatorFn,
  inviteFields,
  memberFields,
  userFields,
  vGroupConnectionPolicy,
  vGroupConnectionProtocol,
  vGroupConnectionStatus,
  vPaginated,
  vScimStatus,
  vWebhookDeliveryStatus,
  vWebhookEndpointStatus,
} from "../component/model";

/**
 * `Id<T>` at the type level, `v.string()` at runtime — for cross-component
 * fields where the consumer's data model lacks the component's table tag.
 */
const vIdString: IdValidatorFn = <T extends string>(_table: T) =>
  v.string() as unknown as VId<GenericId<T>, "required">;

/**
 * Validators a consumer may supply for the `extend` field of each table.
 *
 * Passed as `defineAuth({ extend })`. Every entry is optional; a missing
 * entry falls back to `v.any()`, preserving the untyped default.
 */
export type AuthExtendValidators = {
  /** Shape of `User.extend`. */
  User?: Validator<any, any, any>;
  /** Shape of `Group.extend`. */
  Group?: Validator<any, any, any>;
  /** Shape of `GroupMember.extend`. */
  GroupMember?: Validator<any, any, any>;
};

type ExtendFor<TExtend extends AuthExtendValidators, K extends keyof AuthExtendValidators> =
  TExtend[K] extends Validator<any, any, any> ? TExtend[K] : ReturnType<typeof v.any>;

const docWithExtend = <
  Fields extends Record<string, Validator<any, any, any>>,
  E extends Validator<any, any, any>,
>(
  fields: Fields,
  extend: E,
) =>
  v.object({
    ...(fields as Omit<Fields, "extend">),
    extend: v.optional(extend),
  });

const userFieldsX = userFields(vIdString);
const groupFieldsX = groupFields(vIdString);
const memberFieldsX = memberFields(vIdString);
const inviteDocX = v.object(inviteFields(vIdString));
const emailDocX = v.object(emailFields(vIdString));

const vNullableString = v.union(v.string(), v.null());
const vNullableNumber = v.union(v.number(), v.null());

const vConnectionCheck = v.object({
  name: v.string(),
  ok: v.boolean(),
  message: v.optional(v.string()),
});

const vConnectionIdResult = v.object({ connectionId: v.string() });

const vConnectionGroupResult = v.object({
  connectionId: v.string(),
  groupId: v.string(),
});

const vConnectionDoc = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  groupId: v.string(),
  slug: v.optional(v.string()),
  name: v.optional(v.string()),
  protocol: vGroupConnectionProtocol,
  status: vGroupConnectionStatus,
  config: v.optional(v.any()),
  extend: v.optional(v.any()),
});

const vConnectionDomainDoc = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  connectionId: v.string(),
  groupId: v.string(),
  domain: v.string(),
  isPrimary: v.boolean(),
  verifiedAt: v.optional(v.number()),
});

const vConnectionLookup = v.union(
  v.object({
    connection: v.union(vConnectionDoc, v.null()),
    domain: v.union(vConnectionDomainDoc, v.null()),
  }),
  v.null(),
);

const vConnectionDomainSummary = v.object({
  domainId: v.string(),
  domain: v.string(),
  isPrimary: v.boolean(),
  verified: v.boolean(),
  verifiedAt: vNullableNumber,
});

const vConnectionDomainValidation = v.object({
  connectionId: v.string(),
  ready: v.boolean(),
  summary: v.object({
    domainCount: v.number(),
    primaryCount: v.number(),
    verifiedCount: v.number(),
  }),
  domains: v.array(vConnectionDomainSummary),
  warnings: v.array(v.string()),
});

const vConnectionDomainSet = v.object({
  connectionId: v.string(),
  domains: v.array(vConnectionDomainSummary),
});

const vConnectionDomainVerificationRequest = v.object({
  connectionId: v.string(),
  domain: v.string(),
  requestedAt: v.number(),
  expiresAt: v.number(),
  challenge: v.object({
    recordType: v.literal("TXT"),
    recordName: v.string(),
    recordValue: v.string(),
  }),
});

const vConnectionDomainVerificationConfirm = v.object({
  connectionId: v.string(),
  domain: v.string(),
  verifiedAt: v.optional(v.number()),
  checks: v.array(vConnectionCheck),
});

const vConnectionStatus = v.object({
  connectionId: v.string(),
  status: vGroupConnectionStatus,
  ready: v.boolean(),
  domainCount: v.number(),
  protocols: v.object({
    oidc: v.object({
      configured: v.boolean(),
      ready: v.boolean(),
      clientId: vNullableString,
      issuer: vNullableString,
    }),
    saml: v.object({
      configured: v.boolean(),
      ready: v.boolean(),
      entityId: vNullableString,
    }),
    scim: v.object({
      configured: v.boolean(),
      ready: v.boolean(),
      basePath: vNullableString,
      deprovisionMode: v.union(v.literal("soft"), v.literal("hard")),
    }),
  }),
});

const vConnectionOidcConfig = v.object({
  enabled: v.optional(v.boolean()),
  discovery: v.optional(v.any()),
  client: v.optional(v.any()),
  request: v.optional(v.any()),
  security: v.optional(v.any()),
  profile: v.optional(v.any()),
  hasClientSecret: v.optional(v.boolean()),
});

const vConnectionValidation = v.object({
  ok: v.boolean(),
  connectionId: v.string(),
  checks: v.array(vConnectionCheck),
});

const vConnectionPolicyValidation = v.object({
  ok: v.boolean(),
  groupId: v.string(),
  policy: v.optional(vGroupConnectionPolicy),
  checks: v.array(vConnectionCheck),
});

const vConnectionScimConfig = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  connectionId: v.string(),
  groupId: v.string(),
  status: vScimStatus,
  basePath: v.string(),
  lastRotatedAt: v.optional(v.number()),
  extend: v.optional(v.any()),
  hasToken: v.boolean(),
  security: v.optional(v.any()),
  profile: v.optional(v.any()),
});

const vConnectionScimSet = v.object({
  connectionId: v.string(),
  configId: v.string(),
  basePath: v.string(),
  token: v.string(),
});

const vConnectionScimValidation = v.object({
  ok: v.boolean(),
  connectionId: v.string(),
  basePath: v.optional(v.string()),
  deprovisionMode: v.optional(v.union(v.literal("soft"), v.literal("hard"))),
  capabilities: v.optional(
    v.object({
      users: v.boolean(),
      groups: v.boolean(),
      patch: v.boolean(),
      put: v.boolean(),
      filters: v.array(v.string()),
      bulk: v.boolean(),
      etag: v.boolean(),
    }),
  ),
  checks: v.array(vConnectionCheck),
});

const vConnectionSignIn = v.object({
  connectionId: v.string(),
  providerId: v.string(),
  protocol: vGroupConnectionProtocol,
  signInPath: v.string(),
  callbackPath: v.string(),
  redirectTo: v.optional(v.string()),
});

const vConnectionAuditEvent = v.object({
  _id: v.string(),
  _creationTime: v.number(),
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

const vConnectionWebhookEndpoint = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  connectionId: v.string(),
  groupId: v.string(),
  url: v.string(),
  status: vWebhookEndpointStatus,
  subscriptions: v.array(vAuthEventKind),
  createdByUserId: v.optional(v.string()),
  lastSuccessAt: v.optional(v.number()),
  lastFailureAt: v.optional(v.number()),
  failureCount: v.number(),
  extend: v.optional(v.any()),
  hasSecret: v.boolean(),
});

const vConnectionWebhookDelivery = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  connectionId: v.string(),
  endpointId: v.string(),
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

const connectionValidators = {
  protocol: vGroupConnectionProtocol,
  doc: vConnectionDoc,
  lookup: vConnectionLookup,
  id: vConnectionIdResult,
  created: vConnectionGroupResult,
  status: vConnectionStatus,
  validation: vConnectionValidation,
  signIn: vConnectionSignIn,
  domain: {
    doc: vConnectionDomainDoc,
    summary: vConnectionDomainSummary,
    validation: vConnectionDomainValidation,
    upsert: vConnectionDomainSet,
    verificationRequest: vConnectionDomainVerificationRequest,
    verificationConfirm: vConnectionDomainVerificationConfirm,
  },
  oidc: {
    config: vConnectionOidcConfig,
    validation: vConnectionValidation,
  },
  saml: {
    validation: vConnectionValidation,
    metadata: v.string(),
  },
  policy: {
    config: vGroupConnectionPolicy,
    validation: vConnectionPolicyValidation,
  },
  scim: {
    config: vConnectionScimConfig,
    upsert: vConnectionScimSet,
    validation: vConnectionScimValidation,
  },
  audit: {
    event: vConnectionAuditEvent,
  },
  webhook: {
    endpoint: vConnectionWebhookEndpoint,
    delivery: vConnectionWebhookDelivery,
    disabled: v.object({ endpointId: v.string() }),
  },
};

/**
 * Build the `auth.v.*` validator namespace from the consumer's `extend`
 * config. Each doc validator's `extend` field is rebuilt with the
 * supplied validator so the inferred type carries the real shape.
 *
 * @typeParam TExtend - The consumer's per-table `extend` validators.
 * @param extend - The `extend` map from `defineAuth` config. Defaults to
 *   an empty object (all `extend` fields stay `v.any()`).
 * @returns The `auth.v` namespace: `user`, `group`, `member`, `invite`,
 *   `viewer`, `viewerWithGroups`, and the `list` page-wrapper helper.
 *
 * @example
 * ```ts
 * const av = createAuthValidators({
 *   User: v.object({ stripeCustomerId: v.optional(v.string()) }),
 * });
 * // Infer<typeof av.viewer> -> User document with typed `extend`
 * ```
 */
export function createAuthValidators<TExtend extends AuthExtendValidators>(
  extend: TExtend = {} as TExtend,
) {
  const user = docWithExtend<typeof userFieldsX, ExtendFor<TExtend, "User">>(
    userFieldsX,
    (extend.User ?? v.any()) as ExtendFor<TExtend, "User">,
  );
  const group = docWithExtend<typeof groupFieldsX, ExtendFor<TExtend, "Group">>(
    groupFieldsX,
    (extend.Group ?? v.any()) as ExtendFor<TExtend, "Group">,
  );
  const member = docWithExtend<typeof memberFieldsX, ExtendFor<TExtend, "GroupMember">>(
    memberFieldsX,
    (extend.GroupMember ?? v.any()) as ExtendFor<TExtend, "GroupMember">,
  );
  const invite = inviteDocX;
  const email = emailDocX;
  const viewer = v.union(user, v.null());

  return {
    /** Single User document validator (extend-aware). */
    user,
    /** Single Group document validator (extend-aware). */
    group,
    /** Single GroupMember document validator (extend-aware). */
    member,
    /** Single GroupInvite document validator. */
    invite,
    /** Single UserEmail document validator. */
    email,
    /** `User | null` — for a `viewer`/current-user query. */
    viewer,
    /** Wrap any item validator in Convex's native pagination result shape. */
    list: vPaginated,
    /** Validators for the group connection admin facade. */
    connection: connectionValidators,
  };
}

/**
 * The `auth.v` namespace type, parameterized by the consumer's `extend`.
 *
 * @typeParam TExtend - The consumer's per-table `extend` validators.
 */
export type AuthValidators<TExtend extends AuthExtendValidators = {}> = ReturnType<
  typeof createAuthValidators<TExtend>
>;

/**
 * Inferred current-user document type (extend-aware).
 *
 * @typeParam TExtend - The consumer's per-table `extend` validators.
 */
export type Viewer<TExtend extends AuthExtendValidators = {}> = Infer<
  AuthValidators<TExtend>["user"]
>;
/**
 * Inferred Group document type (extend-aware).
 *
 * @typeParam TExtend - The consumer's per-table `extend` validators.
 */
export type Group<TExtend extends AuthExtendValidators = {}> = Infer<
  AuthValidators<TExtend>["group"]
>;
/**
 * Inferred GroupMember document type (extend-aware).
 *
 * @typeParam TExtend - The consumer's per-table `extend` validators.
 */
export type Membership<TExtend extends AuthExtendValidators = {}> = Infer<
  AuthValidators<TExtend>["member"]
>;
