/**
 * Single source of truth for the auth event taxonomy.
 *
 * Every auth event kind and its category is declared once in {@link EVENT_KINDS}.
 * The server ({@link file://../../server/events.ts}) derives the `AuthEventKind`
 * TS union, the `EVENT_KIND_CATEGORY` map, and the compile-time-exhaustive
 * handler selector table; the component ({@link file://../../component/model.ts})
 * derives the `vAuthEventKind` / `vAuthEventCategory` validators. This module
 * holds no Convex imports so both sides can import it without crossing the
 * component/server boundary.
 *
 * @module
 */

export const EVENT_CATEGORIES = [
  "user",
  "session",
  "account",
  "password",
  "passkey",
  "totp",
  "email",
  "phone",
  "api_key",
  "oauth",
  "connection",
  "scim",
  "webhook",
  "security",
] as const;

/** High-level category grouping for an auth event. */
export type AuthEventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * The auth event taxonomy: every emitted kind mapped to its category.
 *
 * This is the one place kinds and their categories are declared. Do not change
 * which kinds exist or their categories without intent; this is the
 * load-bearing audit taxonomy consumed by the projection, webhook dispatch,
 * and every event handler.
 */
export const EVENT_KINDS = {
  "user.created": { category: "user" },
  "user.updated": { category: "user" },
  "session.signed_in": { category: "session" },
  "session.signed_out": { category: "session" },
  "session.invalidated": { category: "session" },
  "session.refresh_exchanged": { category: "session" },
  "session.refresh_reuse_detected": { category: "session" },
  "account.linked": { category: "account" },
  "account.unlinked": { category: "account" },
  "password.changed": { category: "password" },
  "passkey.added": { category: "passkey" },
  "passkey.removed": { category: "passkey" },
  "totp.enrolled": { category: "totp" },
  "totp.removed": { category: "totp" },
  "email.verified": { category: "email" },
  "phone.verified": { category: "phone" },
  "api_key.created": { category: "api_key" },
  "api_key.revoked": { category: "api_key" },
  "oauth.client.created": { category: "oauth" },
  "oauth.client.revoked": { category: "oauth" },
  "oauth.code.created": { category: "oauth" },
  "oauth.token.created": { category: "oauth" },
  "oauth.token.exchanged": { category: "oauth" },
  "oauth.refresh.reuse_detected": { category: "oauth" },
  "oauth.refresh.revoked": { category: "oauth" },
  "connection.created": { category: "connection" },
  "connection.updated": { category: "connection" },
  "connection.removed": { category: "connection" },
  "connection.login.succeeded": { category: "connection" },
  "connection.login.failed": { category: "connection" },
  "connection.domain.verification_requested": { category: "connection" },
  "connection.domain.verified": { category: "connection" },
  "connection.policy.updated": { category: "connection" },
  "connection.saml.set": { category: "connection" },
  "connection.saml.refreshed": { category: "connection" },
  "connection.oidc.set": { category: "connection" },
  "connection.scim.set": { category: "scim" },
  "connection.scim.read": { category: "scim" },
  "connection.scim.user.provisioned": { category: "scim" },
  "connection.scim.user.updated": { category: "scim" },
  "connection.scim.user.deactivated": { category: "scim" },
  "connection.scim.user.reactivated": { category: "scim" },
  "connection.scim.group.provisioned": { category: "scim" },
  "connection.scim.group.updated": { category: "scim" },
  "connection.scim.group.deactivated": { category: "scim" },
  "connection.scim.group.reactivated": { category: "scim" },
  "webhook.endpoint.created": { category: "webhook" },
  "webhook.endpoint.disabled": { category: "webhook" },
  "webhook.delivery.created": { category: "webhook" },
  "webhook.delivery.attempted": { category: "webhook" },
  "webhook.delivery.succeeded": { category: "webhook" },
  "webhook.delivery.failed": { category: "webhook" },
} as const satisfies Record<string, { category: AuthEventCategory }>;

/** Discriminator naming the specific auth event that occurred. */
export type AuthEventKind = keyof typeof EVENT_KINDS;

/** Ordered tuple of every {@link AuthEventKind}, for deriving validators. */
export const AUTH_EVENT_KINDS = Object.keys(EVENT_KINDS) as [AuthEventKind, ...AuthEventKind[]];

/**
 * Map from every {@link AuthEventKind} to its {@link AuthEventCategory},
 * derived from {@link EVENT_KINDS}.
 */
export const EVENT_KIND_CATEGORY: Record<AuthEventKind, AuthEventCategory> = Object.fromEntries(
  AUTH_EVENT_KINDS.map((kind) => [kind, EVENT_KINDS[kind].category]),
) as Record<AuthEventKind, AuthEventCategory>;
