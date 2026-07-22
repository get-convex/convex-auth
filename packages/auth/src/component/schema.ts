import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  vApiKeyRateLimit,
  vApiKeyRateLimitState,
  vApiKeyScope,
  vAuthEventActorType,
  vAuthEventCategory,
  vAuthEventData,
  vAuthEventKind,
  vAuthEventOutcome,
  vAuthEventTargetKind,
  vAuthEventSubjectType,
  vDeviceStatus,
  vGroupConnectionPolicy,
  vGroupConnectionProtocol,
  vGroupConnectionSecretKind,
  vGroupConnectionStatus,
  vInviteStatus,
  vScimResourceType,
  vScimStatus,
  vTokenEndpointAuthMethod,
  vWebhookDeliveryStatus,
  vWebhookEndpointStatus,
} from "./model";

/**
 * Schema for the auth component.
 *
 * Contains tables for core authentication (users, sessions, accounts, tokens,
 * verification codes, PKCE verifiers, rate limits) and hierarchical group
 * management (groups, members, invites).
 */
export default defineSchema({
  /**
   * Authenticated users. A user may have multiple linked accounts
   * and multiple concurrent sessions.
   */
  User: defineTable({
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    lastActiveGroup: v.optional(v.id("Group")),
    /**
     * @deprecated Retained so pre-existing rows still validate after the
     * denormalized-cache removal. Still accepted on the `user.patch` validator
     * (`vUserPatchData`) until the major-version removal — nothing writes a
     * meaningful value; strip existing data via the `dropHasTotp` migration.
     */
    hasTotp: v.optional(v.boolean()),
    extend: v.optional(v.any()),
  })
    .index("email", ["email"])
    .index("email_verified", ["email", "emailVerificationTime"])
    .index("phone", ["phone"])
    .index("phone_verified", ["phone", "phoneVerificationTime"]),

  /**
   * All emails a user owns, across providers/connections. `User.email`
   * remains the single denormalized primary pointer (the row with
   * `isPrimary: true`); this table is the source of truth for the full
   * set and carries provenance so Connection linking can be connection-scoped.
   *
   * `verificationTime` present ⇔ the email is verified. `source` and
   * `connectionId` record which provider/Connection connection asserted it —
   * email-based account linking for Connection must stay scoped to the same
   * `connectionId` (see server/users.ts) to avoid cross-IdP takeover.
   */
  UserEmail: defineTable({
    userId: v.id("User"),
    email: v.string(),
    verificationTime: v.optional(v.number()),
    isPrimary: v.boolean(),
    source: v.union(
      v.literal("password"),
      v.literal("oauth"),
      v.literal("oidc"),
      v.literal("saml"),
      v.literal("scim"),
    ),
    accountId: v.optional(v.id("Account")),
    provider: v.optional(v.string()),
    connectionId: v.optional(v.id("GroupConnection")),
  })
    .index("user_id", ["userId"])
    .index("user_id_email", ["userId", "email"])
    .index("connection_id_email", ["connectionId", "email"]),

  /**
   * Active sessions. A single user can have multiple concurrent sessions
   * across different devices or browsers. Sessions expire after a
   * configurable duration.
   */
  Session: defineTable({
    userId: v.id("User"),
    expirationTime: v.number(),
  })
    .index("user_id", ["userId"])
    .index("expiration_time", ["expirationTime"]),

  /**
   * Authentication accounts. Each account links a user to a single
   * authentication provider (e.g. Google OAuth, email/password).
   * A user can have multiple accounts linked.
   */
  Account: defineTable({
    userId: v.id("User"),
    provider: v.string(),
    providerAccountId: v.string(),
    secret: v.optional(v.string()),
    emailVerified: v.optional(v.string()),
    phoneVerified: v.optional(v.string()),
    extend: v.optional(v.any()),
  })
    .index("user_id_provider", ["userId", "provider"])
    .index("provider_account_id", ["provider", "providerAccountId"]),

  /**
   * Refresh tokens for session continuity. Tokens are single-use and form
   * a chain — each token references the one it was exchanged from.
   *
   * The active refresh token is the most recently created token that has not
   * been used yet. A 10-second reuse window allows for concurrent requests.
   * Any invalid use of a token invalidates the entire chain.
   */
  RefreshToken: defineTable({
    sessionId: v.id("Session"),
    expirationTime: v.number(),
    firstUsedTime: v.optional(v.number()),
    parentRefreshTokenId: v.optional(v.id("RefreshToken")),
  })
    .index("session_id", ["sessionId"])
    .index("session_id_first_used", ["sessionId", "firstUsedTime"])
    .index("session_id_parent_refresh_token_id", ["sessionId", "parentRefreshTokenId"])
    .index("expiration_time", ["expirationTime"]),

  /**
   * Verification codes for OTP tokens, magic link tokens, and OAuth codes.
   */
  VerificationCode: defineTable({
    accountId: v.id("Account"),
    provider: v.string(),
    code: v.string(),
    expirationTime: v.number(),
    verifier: v.optional(v.string()),
    emailVerified: v.optional(v.string()),
    phoneVerified: v.optional(v.string()),
  })
    .index("account_id", ["accountId"])
    .index("code", ["code"])
    .index("expiration_time", ["expirationTime"]),

  /**
   * PKCE verifiers for OAuth flows. Stores the cryptographic verifier
   * used to prove the authorization request originated from this client.
   */
  AuthVerifier: defineTable({
    sessionId: v.optional(v.id("Session")),
    signature: v.optional(v.string()),
    expirationTime: v.optional(v.number()),
  })
    .index("signature", ["signature"])
    .index("expiration_time", ["expirationTime"]),

  /**
   * WebAuthn passkey credentials. Each credential links a user to a
   * registered authenticator (Touch ID, Face ID, security key, etc.).
   * A user can have multiple passkeys across different devices.
   */
  Passkey: defineTable({
    userId: v.id("User"),
    /** Base64url-encoded credential ID from the authenticator. */
    credentialId: v.string(),
    /** Public key bytes (SEC1 uncompressed for EC, SPKI for RSA). */
    publicKey: v.bytes(),
    /** COSE algorithm identifier (-7 for ES256, -257 for RS256, -8 for EdDSA). */
    algorithm: v.number(),
    /** Signature counter for clone detection. Many authenticators return 0. */
    counter: v.number(),
    /** Authenticator transport hints (e.g. "internal", "hybrid", "usb", "ble", "nfc"). */
    transports: v.optional(v.array(v.string())),
    /** Whether this is a single-device or multi-device (synced) credential. */
    deviceType: v.string(),
    /** Whether the credential is backed up (synced passkey). */
    backedUp: v.boolean(),
    /** User-assigned friendly name (e.g. "MacBook Touch ID"). */
    name: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("user_id", ["userId"])
    .index("credential_id", ["credentialId"]),

  /**
   * TOTP two-factor authentication secrets. Each record links a user to
   * an authenticator app. A user can have multiple TOTP enrollments
   * (e.g. different authenticator apps) but typically has one.
   *
   * The `verified` flag indicates whether the user has completed setup
   * by successfully entering a code from their authenticator app.
   * Unverified enrollments are in-progress setup that can be discarded.
   */
  TotpFactor: defineTable({
    userId: v.id("User"),
    /** Raw TOTP secret key bytes. */
    secret: v.bytes(),
    /** Number of digits in each code (typically 6). */
    digits: v.number(),
    /** Time period in seconds for code rotation (typically 30). */
    period: v.number(),
    /** Whether setup has been confirmed with a valid code. */
    verified: v.boolean(),
    /** User-assigned friendly name (e.g. "Google Authenticator"). */
    name: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("user_id", ["userId"])
    .index("user_id_verified", ["userId", "verified"]),

  /**
   * Device authorization codes (RFC 8628). Each record tracks a pending
   * device auth session — the device polls with `deviceCode` while the
   * user authorizes via `userCode` on a secondary device.
   */
  DeviceCode: defineTable({
    /** High-entropy code used by the device for polling. Stored as SHA-256 hash. */
    deviceCodeHash: v.string(),
    /** Short human-readable code the user enters (e.g. "WDJB-MJHT"). */
    userCode: v.string(),
    /** Expiration timestamp (ms since epoch). */
    expiresAt: v.number(),
    /** Minimum polling interval in seconds. */
    interval: v.number(),
    /** Current status of this device authorization session. */
    status: vDeviceStatus,
    /** Set when the user authorizes — links to the authorizing user. */
    userId: v.optional(v.id("User")),
    /** Set when the user authorizes — the session created for the device. */
    sessionId: v.optional(v.id("Session")),
    /** Timestamp of the last poll request (for slow_down enforcement). */
    lastPolledAt: v.optional(v.number()),
  })
    .index("device_code_hash", ["deviceCodeHash"])
    .index("user_code_status", ["userCode", "status"])
    .index("expires_at", ["expiresAt"]),

  /**
   * Hierarchical groups. A group with no `parentGroupId` is a root group.
   * Groups can nest arbitrarily deep via `parentGroupId` for modeling
   * organizations, teams, departments, or any tree structure.
   */
  Group: defineTable({
    name: v.string(),
    slug: v.optional(v.string()),
    type: v.optional(v.string()),
    parentGroupId: v.optional(v.id("Group")),
    /** Denormalized root group ID. Self-referencing for root groups. */
    rootGroupId: v.optional(v.id("Group")),
    /** Denormalized flag: `true` when `parentGroupId` is absent. */
    isRoot: v.optional(v.boolean()),
    policy: v.optional(vGroupConnectionPolicy),
    extend: v.optional(v.any()),
    /**
     * @deprecated Removed faceted classification tags (was
     * `v.array(v.object({ key, value }))`). Retained as `v.any()` so
     * pre-existing rows still validate on deploy — do NOT re-narrow it here.
     * Clear existing data via the `dropGroupTags` migration, then drop this
     * field in a later major release.
     */
    tags: v.optional(v.any()),
  })
    .index("name", ["name"])
    .index("slug", ["slug"])
    .index("parent_group_id", ["parentGroupId"])
    .index("parent_group_id_name", ["parentGroupId", "name"])
    .index("parent_group_id_slug", ["parentGroupId", "slug"])
    .index("parent_group_id_type", ["parentGroupId", "type"])
    .index("root_group_id", ["rootGroupId"])
    .index("is_root", ["isRoot"])
    .index("type", ["type"])
    .index("type_parent_group_id", ["type", "parentGroupId"]),

  /**
   * Durable state for large group subtree removals and root-id re-stamps.
   * These rows are component-internal implementation details; the public
   * `Group` document stays free of workflow metadata.
   */
  GroupHierarchyOperation: defineTable({
    groupId: v.id("Group"),
    kind: v.union(v.literal("remove"), v.literal("restamp")),
    phase: v.union(v.literal("planning"), v.literal("applying"), v.literal("cleaning")),
    newRootGroupId: v.optional(v.id("Group")),
    expectedParentGroupId: v.optional(v.id("Group")),
  })
    .index("group_id_kind", ["groupId", "kind"])
    .index("group_id_kind_parent_root", [
      "groupId",
      "kind",
      "expectedParentGroupId",
      "newRootGroupId",
    ]),

  /**
   * One durable queue row per group in a hierarchy operation. Keeping work as
   * rows instead of a carried array avoids an unbounded scheduled-function
   * argument/frontier and makes every continuation safe to retry.
   */
  GroupHierarchyWork: defineTable({
    operationId: v.id("GroupHierarchyOperation"),
    kind: v.union(v.literal("remove"), v.literal("restamp")),
    groupId: v.id("Group"),
    parentWorkId: v.optional(v.id("GroupHierarchyWork")),
    expectedParentGroupId: v.optional(v.id("Group")),
    depth: v.number(),
    planned: v.boolean(),
    applied: v.boolean(),
    eligible: v.optional(v.boolean()),
    scanCursor: v.optional(v.string()),
  })
    .index("operation_id_group_id", ["operationId", "groupId"])
    .index("operation_id_planned", ["operationId", "planned"])
    .index("operation_id_applied_depth", ["operationId", "applied", "depth"])
    .index("group_id", ["groupId"])
    .index("group_id_kind", ["groupId", "kind"]),

  /**
   * Group membership. Links a user to a group with an application-defined
   * role (e.g. "owner", "admin", "member", "viewer"). A user can be a
   * member of multiple groups with different roles in each.
   */
  GroupMember: defineTable({
    groupId: v.id("Group"),
    userId: v.id("User"),
    role: v.optional(v.string()),
    roleIds: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    extend: v.optional(v.any()),
  })
    .index("group_id", ["groupId"])
    .index("group_id_user_id", ["groupId", "userId"])
    .index("group_id_status", ["groupId", "status"])
    .index("user_id", ["userId"])
    .index("user_id_status", ["userId", "status"])
    .index("status", ["status"]),

  /**
   * Invitations. Tracks pending, accepted, revoked, and expired
   * invitations. Optionally scoped to a group via `groupId`, or
   * platform-level when `groupId` is omitted.
   *
   * `email` and `invitedByUserId` are optional to support CLI-generated
   * invite links where neither is known upfront.
   */
  GroupInvite: defineTable({
    groupId: v.optional(v.id("Group")),
    invitedByUserId: v.optional(v.id("User")),
    email: v.optional(v.string()),
    tokenHash: v.string(),
    role: v.optional(v.string()),
    roleIds: v.optional(v.array(v.string())),
    status: vInviteStatus,
    expiresTime: v.optional(v.number()),
    acceptedByUserId: v.optional(v.id("User")),
    acceptedTime: v.optional(v.number()),
    extend: v.optional(v.any()),
  })
    .index("token_hash", ["tokenHash"])
    .index("status", ["status"])
    .index("email_status", ["email", "status"])
    .index("email_group_id_status", ["email", "groupId", "status"])
    .index("invited_by_user_id_status", ["invitedByUserId", "status"])
    .index("group_id", ["groupId"])
    .index("group_id_status", ["groupId", "status"])
    .index("group_id_email_status", ["groupId", "email", "status"])
    .index("expires_time", ["expiresTime"]),

  /**
   * Group Connection configuration attached to a root group/organization.
   *
   * The `config` payload intentionally stays flexible so the headless group connection
   * SDK can evolve without forcing schema churn for every protocol-specific
   * field addition.
   */
  GroupConnection: defineTable({
    groupId: v.id("Group"),
    slug: v.optional(v.string()),
    name: v.optional(v.string()),
    protocol: vGroupConnectionProtocol,
    status: vGroupConnectionStatus,
    config: v.optional(v.any()),
    extend: v.optional(v.any()),
  })
    .index("group_id", ["groupId"])
    .index("name", ["name"])
    .index("slug", ["slug"])
    .index("status", ["status"])
    .index("group_id_name", ["groupId", "name"])
    .index("group_id_status", ["groupId", "status"])
    .index("group_id_slug", ["groupId", "slug"]),

  /**
   * Verified or pending domains linked to an group connection record.
   */
  GroupConnectionDomain: defineTable({
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    domain: v.string(),
    isPrimary: v.boolean(),
    verifiedAt: v.optional(v.number()),
  })
    .index("connection_id", ["connectionId"])
    .index("group_id", ["groupId"])
    .index("domain", ["domain"]),

  /**
   * Pending SAML AuthnRequest IDs awaiting a matching ACS response.
   *
   * A row is created when the SP generates a SAML sign-in request and accepted
   * (single-use) at the ACS handler. Because the ID is looked up server-side and
   * marked `acceptedAt`, a captured SAMLResponse/RelayState pair cannot be
   * replayed — the second accept fails. Rows are pruned by `expiresAt`.
   */
  SamlLoginRequest: defineTable({
    connectionId: v.id("GroupConnection"),
    requestId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
  })
    .index("request_id", ["requestId"])
    .index("expires_at", ["expiresAt"]),

  /**
   * Replay cache of SAML assertion IDs already accepted at the ACS handler.
   *
   * Catches IdP-initiated responses that carry no `InResponseTo` (so have no
   * pending {@link SamlLoginRequest} to accept): an assertion ID is recorded
   * on first acceptance and rejected if seen again. `expiresAt` is bounded by
   * the assertion's `NotOnOrAfter`, and rows are pruned by `expiresAt`.
   */
  SamlSeenAssertion: defineTable({
    connectionId: v.id("GroupConnection"),
    assertionId: v.string(),
    expiresAt: v.number(),
  })
    .index("connection_id_assertion_id", ["connectionId", "assertionId"])
    .index("expires_at", ["expiresAt"]),

  /**
   * Pending DNS TXT verification challenges for group connection domains.
   */
  GroupConnectionDomainVerification: defineTable({
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    domainId: v.id("GroupConnectionDomain"),
    domain: v.string(),
    recordName: v.string(),
    token: v.string(),
    tokenHash: v.string(),
    requestedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("connection_id", ["connectionId"])
    .index("domain_id", ["domainId"])
    .index("token_hash", ["tokenHash"])
    // Retention: expired DNS challenges are pruned by `maintenance.pruneExpired`.
    .index("expires_at", ["expiresAt"]),

  /**
   * Encrypted group connection secrets stored separately from protocol config.
   */
  GroupConnectionSecret: defineTable({
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    kind: vGroupConnectionSecretKind,
    ciphertext: v.string(),
    updatedAt: v.number(),
  })
    .index("connection_id", ["connectionId"])
    .index("connection_id_kind", ["connectionId", "kind"])
    .index("group_id", ["groupId"]),

  /**
   * SCIM configuration for an group connection tenant.
   */
  GroupConnectionScimConfig: defineTable({
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    status: vScimStatus,
    basePath: v.string(),
    tokenHash: v.string(),
    lastRotatedAt: v.optional(v.number()),
    extend: v.optional(v.any()),
  })
    .index("group_connection_id", ["connectionId"])
    .index("group_id", ["groupId"])
    .index("token_hash", ["tokenHash"])
    .index("status", ["status"]),

  /**
   * External SCIM identities mapped into local users/groups.
   */
  GroupConnectionScimIdentity: defineTable({
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    resourceType: vScimResourceType,
    externalId: v.string(),
    userId: v.optional(v.id("User")),
    mappedGroupId: v.optional(v.id("Group")),
    lastProvisionedAt: v.optional(v.number()),
    active: v.optional(v.boolean()),
    raw: v.optional(v.any()),
  })
    .index("group_connection_id", ["connectionId"])
    .index("group_id", ["groupId"])
    .index("group_connection_id_resource_type_external_id", [
      "connectionId",
      "resourceType",
      "externalId",
    ])
    .index("group_connection_id_user_id", ["connectionId", "userId"])
    .index("user_id", ["userId"])
    .index("mapped_group_id", ["mappedGroupId"]),

  /**
   * Queryable projection rows for stream-backed auth events.
   *
   * The durable stream owns the immutable event envelope. This table projects
   * the fields auth needs for native Convex reads without duplicating event
   * timelines into multiple tables.
   *
   * NOTE (0.1 upgrade): this table REPLACES the removed `GroupAuditEvent` table.
   * Dropping a table is not deploy-blocking (Convex simply orphans its rows), so
   * there is intentionally NO data-copy migration: the old audit rows used a
   * different taxonomy (`eventType`/`actorType`/`status` vs the event
   * `kind`/`actorType`/`outcome` here) and cannot be projected without lossy
   * guesswork. Pre-0.1 `GroupAuditEvent` history is therefore not carried
   * forward; consumers that need it must export it from the old deployment
   * before upgrading. See `migrations.ts` for the runnable upgrade sequence.
   */
  AuthEventProjection: defineTable({
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
    userAgent: v.optional(v.string()),
    data: v.optional(vAuthEventData),
    streamId: v.string(),
    streamIndex: v.number(),
  })
    .index("target_time", ["targetKind", "targetId", "occurredAt"])
    .index("target_kind_time", ["targetKind", "targetId", "kind", "occurredAt"])
    .index("target_outcome_time", ["targetKind", "targetId", "outcome", "occurredAt"])
    .index("target_kind_outcome_time", ["targetKind", "targetId", "kind", "outcome", "occurredAt"])
    .index("event_id_target", ["eventId", "targetKind", "targetId"])
    .index("kind_time", ["kind", "occurredAt"])
    .index("category_time", ["category", "occurredAt"])
    .index("outcome_time", ["outcome", "occurredAt"])
    .index("actor_time", ["actorType", "actorId", "occurredAt"])
    .index("subject_time", ["subjectType", "subjectId", "occurredAt"])
    .index("request_id_time", ["requestId", "occurredAt"])
    .index("by_stream_index", ["streamIndex"])
    // Retention: `maintenance.pruneExpired` deletes DRAINED rows (streamIndex >= 0)
    // older than the retention window via this index. Undrained rows
    // (streamIndex === -1, not yet in the durable stream) are never pruned.
    .index("occurred_at", ["occurredAt"]),

  /**
   * Webhook endpoints subscribed to group audit and lifecycle events.
   */
  GroupWebhookEndpoint: defineTable({
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    url: v.string(),
    status: vWebhookEndpointStatus,
    /**
     * Endpoint signing secret encrypted with `AUTH_SECRET_ENCRYPTION_KEY`.
     * Decrypted at emit time to HMAC-SHA256 each outbound payload; the
     * dispatch action forwards the precomputed signature in
     * `X-Auth-Signature`.
     *
     * Optional for the 0.1 two-phase upgrade: pre-existing rows carry the
     * one-way `secretHash` and have no `secretCiphertext` yet. The
     * `disableLegacyWebhookEndpoints` migration disables those rows and erases
     * the hash; an operator must provide a new secret before re-enabling them.
     * Tighten back to required in a later release once every live row is
     * encrypted.
     */
    secretCiphertext: v.optional(v.string()),
    /**
     * @deprecated One-way SHA-256 hash from the pre-encryption signing scheme.
     * Retained only so pre-existing rows validate on deploy; the endpoint
     * migration disables hash-only rows and clears this field. It cannot be
     * converted into the original secret. Removed in a later release.
     */
    secretHash: v.optional(v.string()),
    /**
     * Kept permissive (`v.array(v.string())`, not `v.array(vAuthEventKind)`) so
     * rows holding pre-rename kind strings validate on deploy. The
     * `renameWebhookEndpointSubscriptions` migration remaps them; re-narrow in a
     * later release.
     */
    subscriptions: v.array(v.string()),
    createdByUserId: v.optional(v.id("User")),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    failureCount: v.number(),
    extend: v.optional(v.any()),
  })
    .index("group_connection_id", ["connectionId"])
    .index("group_id", ["groupId"])
    .index("status", ["status"]),

  /**
   * Delivery queue for outbound group webhooks.
   */
  GroupWebhookDelivery: defineTable({
    connectionId: v.id("GroupConnection"),
    endpointId: v.id("GroupWebhookEndpoint"),
    /**
     * `eventId`/`kind`/`signature`/`signedAt` became required after the
     * audit→event migration. Relaxed to optional for the 0.1 two-phase upgrade
     * so pre-existing rows (which instead carry `eventType`/`auditEventId`, and
     * may predate `signature`/`signedAt`) validate on deploy. The
     * `renameWebhookDeliveryKinds` migration backfills them from the legacy
     * fields; tighten back to required in a later release.
     */
    eventId: v.optional(v.string()),
    kind: v.optional(vAuthEventKind),
    status: vWebhookDeliveryStatus,
    attemptCount: v.number(),
    nextAttemptAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastResponseStatus: v.optional(v.number()),
    lastError: v.optional(v.string()),
    payload: v.any(),
    /** HMAC-SHA256 hex of `${signedAt}.${body}` using the endpoint secret. */
    signature: v.optional(v.string()),
    /** Epoch ms used in the signature pre-image. */
    signedAt: v.optional(v.number()),
    /**
     * @deprecated Legacy pre-`event` audit fields. `eventType` held the old
     * audit event-type string; `auditEventId` referenced the dropped
     * `GroupAuditEvent` table (kept as `v.string()` since that table no longer
     * exists). Retained so pre-existing rows validate on deploy; the
     * `renameWebhookDeliveryKinds` migration reads them to backfill
     * `kind`/`eventId`, then clears them. Removed in a later release.
     */
    eventType: v.optional(v.string()),
    auditEventId: v.optional(v.string()),
  })
    .index("group_connection_id", ["connectionId"])
    .index("status_next_attempt_at", ["status", "nextAttemptAt"])
    .index("status_signed_at", ["status", "signedAt"])
    .index("endpoint_id_status", ["endpointId", "status"])
    .index("event_id", ["eventId"])
    .index("event_id_endpoint_id", ["eventId", "endpointId"]),

  /**
   * API keys for programmatic access. Each key links a user to a set of
   * scoped permissions and optional per-key rate limiting.
   *
   * The raw key is never stored — only a SHA-256 hash. A short prefix
   * (e.g. "sk_abc1...") is kept for display in admin interfaces.
   *
   * Keys support:
   * - **Scoped permissions**: resource:action pairs (e.g. users:read)
   * - **Per-key rate limiting**: token-bucket with configurable window
   * - **Expiration**: optional TTL
   * - **Soft revocation**: `revoked` flag preserves audit trail
   */
  ApiKey: defineTable({
    userId: v.id("User"),
    /** First chars of the key for display (e.g. "sk_abc1..."). */
    prefix: v.string(),
    /** SHA-256 hex hash of the full raw key. */
    hashedKey: v.string(),
    /** User-assigned name (e.g. "CI Pipeline", "Production API"). */
    name: v.string(),
    /** Scoped permissions: [{ resource: "users", actions: ["read", "list"] }]. */
    scopes: v.array(vApiKeyScope),
    /** Optional per-key rate limit configuration. */
    rateLimit: v.optional(vApiKeyRateLimit),
    /** Rate limit state tracking (token-bucket). */
    rateLimitState: v.optional(vApiKeyRateLimitState),
    /** Expiration timestamp. Null/undefined = never expires. */
    expiresAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    /** Soft-revoke flag. Revoked keys are kept for audit trail. */
    revoked: v.boolean(),
    /** Arbitrary app-specific metadata attached to the key. */
    extend: v.optional(v.any()),
    /**
     * @deprecated Renamed to `extend`. Retained so pre-existing rows validate on
     * deploy; the `backfillApiKeyExtend` migration copies it into `extend` (when
     * `extend` is unset) and clears this. Removed in a later release.
     */
    metadata: v.optional(v.any()),
  })
    .index("user_id", ["userId"])
    .index("hashed_key", ["hashedKey"]),

  OAuthClient: defineTable({
    clientId: v.string(),
    clientSecretHash: v.optional(v.string()),
    name: v.string(),
    redirectUris: v.array(v.string()),
    scopes: v.array(v.string()),
    grantTypes: v.array(v.string()),
    /** RFC 7591 token-endpoint auth method; `none` = public client. Optional
     *  so pre-existing rows validate before the backfill migration runs. */
    tokenEndpointAuthMethod: v.optional(vTokenEndpointAuthMethod),
    /** SHA-256 of the RFC 7592 registration access token (management bearer). */
    registrationAccessTokenHash: v.optional(v.string()),
    createdBy: v.optional(v.id("User")),
    revoked: v.boolean(),
    /** Set when revoked; optional until the compatibility backfill runs. */
    revokedAt: v.optional(v.number()),
    extend: v.optional(v.any()),
  })
    .index("client_id", ["clientId"])
    .index("created_by", ["createdBy"])
    .index("created_by_revoked", ["createdBy", "revoked"])
    .index("revoked", ["revoked"])
    .index("revoked_at", ["revoked", "revokedAt"]),

  OAuthCode: defineTable({
    codeHash: v.string(),
    userId: v.id("User"),
    clientId: v.string(),
    redirectUri: v.string(),
    scopes: v.array(v.string()),
    codeChallenge: v.string(),
    resource: v.optional(v.string()),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("code_hash", ["codeHash"])
    .index("user_id", ["userId"])
    // Retention: single-use codes are pruned past expiry by `maintenance.pruneExpired`.
    .index("expires_at", ["expiresAt"]),

  /**
   * Root record for a refresh-token rotation chain (one per code exchange).
   * Carries the identity/authorization shared by every token in the chain;
   * setting `revokedAt` kills the whole chain in O(1) (reuse-detection / sign-out)
   * — token lookups reject a revoked or missing grant before the bounded,
   * scheduled token-row cleanup runs. Mirrors `Session` for OAuth refresh.
   */
  OAuthRefreshGrant: defineTable({
    clientId: v.string(),
    userId: v.id("User"),
    scopes: v.array(v.string()),
    resource: v.optional(v.string()),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("expires_at", ["expiresAt"])
    .index("revoked_at", ["revokedAt"]),

  OAuthRefreshToken: defineTable({
    tokenHash: v.string(),
    grantId: v.optional(v.id("OAuthRefreshGrant")),
    expiresAt: v.number(),
    firstUsedTime: v.optional(v.number()),
    parentTokenId: v.optional(v.id("OAuthRefreshToken")),
  })
    .index("token_hash", ["tokenHash"])
    .index("grant_id", ["grantId"])
    .index("grant_id_first_used", ["grantId", "firstUsedTime"])
    .index("grant_id_parent_token_id_first_used", ["grantId", "parentTokenId", "firstUsedTime"])
    .index("expires_at", ["expiresAt"]),
});
