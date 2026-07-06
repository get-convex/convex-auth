/**
 * Typed auth event refs, handlers, filters, and server facade helpers.
 *
 * @module
 */

import type { PaginationOptions } from "convex/server";
import type { GenericId } from "convex/values";

import {
  EVENT_KIND_CATEGORY,
  type AuthEventCategory,
  type AuthEventKind,
} from "../shared/event/kinds";
import type { AuthComponentApi } from "./component/api";
import type { ComponentCtx } from "./component/context";
import { generateRandomString } from "./random";

export type { AuthEventCategory, AuthEventKind };

type Awaitable<T> = T | PromiseLike<T>;
export type AuthEventJson =
  | null
  | boolean
  | number
  | string
  | AuthEventJson[]
  | { [key: string]: AuthEventJson };
export type AuthEventObject = { [key: string]: unknown };
export type AuthProfileSnapshot = AuthEventObject;
export type OidcClaims = AuthEventObject;
export type SamlClaims = AuthEventObject;
export type ScimRawAttributes = AuthEventObject;
type AuthEventCtx = ComponentCtx;

export type AuthEventOutcome = "success" | "failure";
export type AuthEventTargetKind =
  | "user"
  | "session"
  | "group"
  | "connection"
  | "oauth_client"
  | "api_key"
  | "global";

export type AuthEventActorType =
  | "user"
  | "system"
  | "scim"
  | "api_key"
  | "oauth_client"
  | "webhook"
  | "anonymous";

export type AuthEventSubjectType =
  | "user"
  | "session"
  | "account"
  | "passkey"
  | "totp"
  | "email"
  | "phone"
  | "api_key"
  | "oauth_client"
  | "oauth_code"
  | "group"
  | "connection"
  | "scim_identity"
  | "webhook_endpoint"
  | "webhook_delivery"
  | "system";

export type AuthEventRef<K extends AuthEventKind = AuthEventKind> = {
  readonly id: K;
  readonly __authEventKind: K;
};

type ScopeIdForKind<K extends AuthEventTargetKind> = K extends "user"
  ? GenericId<"User">
  : K extends "session"
    ? GenericId<"Session">
    : K extends "group"
      ? GenericId<"Group">
      : K extends "connection"
        ? GenericId<"GroupConnection">
        : K extends "oauth_client"
          ? GenericId<"OAuthClient"> | string
          : K extends "api_key"
            ? GenericId<"ApiKey">
            : K extends "global"
              ? "security"
              : string;

export type AuthEventTarget<
  K extends AuthEventTargetKind = AuthEventTargetKind,
  Id extends string = ScopeIdForKind<K>,
> = {
  readonly kind: K;
  readonly id: Id;
  readonly __authEventScope: K;
};

export type AuthEventTargetScope<K extends AuthEventTargetKind = AuthEventTargetKind> = {
  readonly kind: K;
  readonly id: string;
};

export type AuthEventActor<T extends AuthEventActorType = AuthEventActorType> = {
  type: T;
  id?: string;
};

export type AuthEventSubject<T extends AuthEventSubjectType = AuthEventSubjectType> = {
  type: T;
  id?: string;
};

export type AuthEventRequest = {
  requestId?: string;
  ip?: string;
  userAgent?: string;
};

export type AuthEventDataByKind<TExtend = {}> = {
  "user.created": { type: string; provider: string; profile?: AuthProfileSnapshot };
  "user.updated": {
    existingUserId?: string;
    type?: string;
    provider?: string;
    profile?: AuthProfileSnapshot;
  };
  "session.signed_in": { provider: string; method?: string };
  "session.signed_out": undefined;
  "session.invalidated": { userId: string; reason?: string };
  "session.refresh_exchanged": { sessionId?: string };
  "session.refresh_reuse_detected": { userId?: string; refreshTokenId?: string };
  "account.linked": { provider: string; providerAccountId?: string };
  "account.unlinked": { accountId: string; provider: string };
  "password.changed": { userId?: string; flow?: "reset" | "change" };
  "passkey.added": { passkeyId: string; credentialId?: string };
  "passkey.removed": { passkeyId: string };
  "totp.enrolled": { totpId: string };
  "totp.removed": { totpId: string };
  "email.verified": { userId: string; email: string };
  "phone.verified": { userId: string; phone: string };
  "api_key.created": { keyId: string; name?: string; prefix?: string };
  "api_key.revoked": { keyId: string; reason?: string };
  "oauth.client.created": { clientId: string; name?: string; scopes?: string[] };
  "oauth.client.revoked": { clientId: string };
  "oauth.code.created": {
    clientId: string;
    codeId?: string;
    scopes?: string[];
    redirectUri?: string;
  };
  "oauth.token.created": {
    clientId: string;
    scopes?: string[];
    grantType?: string;
    resource?: string;
  };
  "oauth.token.exchanged": {
    clientId: string;
    scopes?: string[];
    grantType?: string;
    resource?: string;
  };
  "oauth.refresh.reuse_detected": { clientId: string; userId?: string };
  "oauth.refresh.revoked": { clientId: string; userId?: string };
  "connection.created": { connectionId: string; protocol?: "oidc" | "saml"; domain?: string };
  "connection.updated": { connectionId: string; changed?: string[] };
  "connection.removed": { connectionId: string };
  "connection.login.succeeded": {
    connectionId: string;
    protocol: "oidc" | "saml";
    userId?: string;
  };
  "connection.login.failed": {
    connectionId?: string;
    protocol?: "oidc" | "saml";
    errorCode?: string;
  };
  "connection.domain.verification_requested": {
    connectionId: string;
    domain: string;
    recordName?: string;
    expiresAt?: number;
  };
  "connection.domain.verified": { connectionId: string; domain: string; verifiedAt?: number };
  "connection.policy.updated": { version: number };
  "connection.saml.set": { connectionId: string; metadataUrl?: string; domains?: string[] };
  "connection.saml.refreshed": { connectionId: string; metadataUrl?: string };
  "connection.oidc.set": {
    connectionId: string;
    issuer?: string;
    discoveryUrl?: string;
    jwksUri?: string;
    audience?: string | string[];
    tokenEndpointAuthMethod?: string;
  };
  "connection.scim.set": { scimConfigId: string };
  "connection.scim.read": {
    resourceType?: "user" | "group";
    resourceId?: string;
    operation?: string;
  };
  "connection.scim.user.provisioned": { userId?: string; externalId?: string; active?: boolean };
  "connection.scim.user.updated": { userId?: string; externalId?: string; active?: boolean };
  "connection.scim.user.deactivated": { userId?: string; externalId?: string };
  "connection.scim.user.reactivated": { userId?: string; externalId?: string };
  "connection.scim.group.provisioned": { groupId?: string; externalId?: string };
  "connection.scim.group.updated": { groupId?: string; externalId?: string };
  "connection.scim.group.deactivated": { groupId?: string; externalId?: string };
  "connection.scim.group.reactivated": { groupId?: string; externalId?: string };
  "webhook.endpoint.created": { endpointId?: string };
  "webhook.endpoint.disabled": { endpointId?: string };
  "webhook.delivery.created": {
    deliveryId: string;
    endpointId: string;
    sourceEventId: string;
    sourceEventType: AuthEventKind;
  };
  "webhook.delivery.attempted": {
    deliveryId: string;
    endpointId: string;
    sourceEventId: string;
    sourceEventType: AuthEventKind;
    attemptCount: number;
  };
  "webhook.delivery.succeeded": {
    deliveryId: string;
    endpointId: string;
    sourceEventId: string;
    sourceEventType: AuthEventKind;
    status: number;
  };
  "webhook.delivery.failed": {
    deliveryId: string;
    endpointId: string;
    sourceEventId: string;
    sourceEventType: AuthEventKind;
    status?: number;
    error?: string;
  };
} & TExtend;

type EventData<K extends AuthEventKind, TExtend = {}> = AuthEventDataByKind<TExtend>[K];

type EventDataField<K extends AuthEventKind, TExtend = {}> = K extends AuthEventKind
  ? EventData<K, TExtend> extends undefined
    ? { data?: undefined }
    : { data: EventData<K, TExtend> }
  : never;

type AuthEventBase<K extends AuthEventKind = AuthEventKind> = {
  eventId: string;
  kind: K;
  category: AuthEventCategory;
  occurredAt: number;
  actor: AuthEventActor;
  subject: AuthEventSubject;
  targets: AuthEventTargetScope[];
  request?: AuthEventRequest;
  outcome: AuthEventOutcome;
  errorCode?: string;
};

export type AuthEvent<
  K extends AuthEventKind = AuthEventKind,
  TExtend = {},
> = K extends AuthEventKind ? AuthEventBase<K> & EventDataField<K, TExtend> : never;

type AuthEventWhereFilter = {
  target?: AuthEventTarget;
  kind?: AuthEventKind;
  category?: AuthEventCategory;
  outcome?: AuthEventOutcome;
  actor?: AuthEventActor;
  subject?: AuthEventSubject;
  requestId?: string;
  occurredAtGte?: number;
  occurredAtGt?: number;
  occurredAtLte?: number;
  occurredAtLt?: number;
};

type AuthEventHandler<K extends AuthEventKind, TExtend = {}> = (
  ctx: AuthEventCtx,
  event: AuthEvent<K, TExtend>,
) => Awaitable<void>;

export type AuthEventHandlerMap<TExtend = {}> = {
  user?: {
    created?: AuthEventHandler<"user.created", TExtend>;
    updated?: AuthEventHandler<"user.updated", TExtend>;
  };
  session?: {
    signedIn?: AuthEventHandler<"session.signed_in", TExtend>;
    signedOut?: AuthEventHandler<"session.signed_out", TExtend>;
    invalidated?: AuthEventHandler<"session.invalidated", TExtend>;
    refreshExchanged?: AuthEventHandler<"session.refresh_exchanged", TExtend>;
    refreshReuseDetected?: AuthEventHandler<"session.refresh_reuse_detected", TExtend>;
  };
  account?: {
    linked?: AuthEventHandler<"account.linked", TExtend>;
    unlinked?: AuthEventHandler<"account.unlinked", TExtend>;
  };
  password?: {
    changed?: AuthEventHandler<"password.changed", TExtend>;
  };
  passkey?: {
    added?: AuthEventHandler<"passkey.added", TExtend>;
    removed?: AuthEventHandler<"passkey.removed", TExtend>;
  };
  totp?: {
    enrolled?: AuthEventHandler<"totp.enrolled", TExtend>;
    removed?: AuthEventHandler<"totp.removed", TExtend>;
  };
  email?: {
    verified?: AuthEventHandler<"email.verified", TExtend>;
  };
  phone?: {
    verified?: AuthEventHandler<"phone.verified", TExtend>;
  };
  apiKey?: {
    created?: AuthEventHandler<"api_key.created", TExtend>;
    revoked?: AuthEventHandler<"api_key.revoked", TExtend>;
  };
  oauth?: {
    clientCreated?: AuthEventHandler<"oauth.client.created", TExtend>;
    clientRevoked?: AuthEventHandler<"oauth.client.revoked", TExtend>;
    codeCreated?: AuthEventHandler<"oauth.code.created", TExtend>;
    tokenCreated?: AuthEventHandler<"oauth.token.created", TExtend>;
    tokenExchanged?: AuthEventHandler<"oauth.token.exchanged", TExtend>;
    refreshReuseDetected?: AuthEventHandler<"oauth.refresh.reuse_detected", TExtend>;
    refreshRevoked?: AuthEventHandler<"oauth.refresh.revoked", TExtend>;
  };
  connection?: {
    connectionCreated?: AuthEventHandler<"connection.created", TExtend>;
    connectionUpdated?: AuthEventHandler<"connection.updated", TExtend>;
    connectionRemoved?: AuthEventHandler<"connection.removed", TExtend>;
    loginSucceeded?: AuthEventHandler<"connection.login.succeeded", TExtend>;
    loginFailed?: AuthEventHandler<"connection.login.failed", TExtend>;
    domainVerificationRequested?: AuthEventHandler<
      "connection.domain.verification_requested",
      TExtend
    >;
    domainVerified?: AuthEventHandler<"connection.domain.verified", TExtend>;
    policyUpdated?: AuthEventHandler<"connection.policy.updated", TExtend>;
    samlSet?: AuthEventHandler<"connection.saml.set", TExtend>;
    samlRefreshed?: AuthEventHandler<"connection.saml.refreshed", TExtend>;
    oidcSet?: AuthEventHandler<"connection.oidc.set", TExtend>;
  };
  scim?: {
    set?: AuthEventHandler<"connection.scim.set", TExtend>;
    read?: AuthEventHandler<"connection.scim.read", TExtend>;
    userProvisioned?: AuthEventHandler<"connection.scim.user.provisioned", TExtend>;
    userUpdated?: AuthEventHandler<"connection.scim.user.updated", TExtend>;
    userDeactivated?: AuthEventHandler<"connection.scim.user.deactivated", TExtend>;
    userReactivated?: AuthEventHandler<"connection.scim.user.reactivated", TExtend>;
    groupProvisioned?: AuthEventHandler<"connection.scim.group.provisioned", TExtend>;
    groupUpdated?: AuthEventHandler<"connection.scim.group.updated", TExtend>;
    groupDeactivated?: AuthEventHandler<"connection.scim.group.deactivated", TExtend>;
    groupReactivated?: AuthEventHandler<"connection.scim.group.reactivated", TExtend>;
  };
  webhook?: {
    endpointCreated?: AuthEventHandler<"webhook.endpoint.created", TExtend>;
    endpointDisabled?: AuthEventHandler<"webhook.endpoint.disabled", TExtend>;
  };
};

type AuthEventWhereField = keyof Pick<
  AuthEventWhereFilter,
  "target" | "kind" | "category" | "outcome" | "actor" | "subject" | "requestId"
>;

/**
 * Value {@link AuthEventWhereBuilder.eq} accepts for a field. Equals the stored
 * filter type for every field except `kind`, which takes an {@link AuthEventRef}
 * and is stored as its underlying `AuthEventKind` id.
 */
type AuthEventEqValue<F extends AuthEventWhereField> = F extends "kind"
  ? AuthEventRef
  : NonNullable<AuthEventWhereFilter[F]>;

/**
 * Per-field setters mapping the caller-supplied {@link AuthEventEqValue} to the
 * value stored in {@link AuthEventWhereFilter} — isolating the single `kind`
 * ref→id transform; every other field is identity.
 */
const authEventEqSetters: {
  [F in AuthEventWhereField]: (value: AuthEventEqValue<F>) => NonNullable<AuthEventWhereFilter[F]>;
} = {
  target: (value) => value,
  kind: (value) => value.id,
  category: (value) => value,
  outcome: (value) => value,
  actor: (value) => value,
  subject: (value) => value,
  requestId: (value) => value,
};

class AuthEventWhereBuilder {
  private readonly where: AuthEventWhereFilter = {};

  /**
   * Constrain the query to events whose `field` equals `value`. For `kind`, pass
   * an {@link AuthEventRef} (e.g. `authEvents.session.signedIn`); other fields
   * take their literal value.
   */
  eq<F extends AuthEventWhereField>(field: F, value: AuthEventEqValue<F>): this {
    this.where[field] = authEventEqSetters[field](value);
    return this;
  }

  gt(field: "occurredAt", value: number): this {
    this.where.occurredAtGt = value;
    return this;
  }

  gte(field: "occurredAt", value: number): this {
    this.where.occurredAtGte = value;
    return this;
  }

  lt(field: "occurredAt", value: number): this {
    this.where.occurredAtLt = value;
    return this;
  }

  lte(field: "occurredAt", value: number): this {
    this.where.occurredAtLte = value;
    return this;
  }

  build(): AuthEventWhereFilter {
    return { ...this.where };
  }
}

export type AuthEventWhereBuilderShape = Pick<
  AuthEventWhereBuilder,
  "eq" | "gt" | "gte" | "lt" | "lte"
>;

export type AuthEventWhereInput = (q: AuthEventWhereBuilderShape) => AuthEventWhereBuilderShape;

export type AuthEventWhere = AuthEventWhereInput;

type ExactAuthEventHandlerMap<T> = T & {
  [K in Exclude<keyof T, keyof AuthEventHandlerMap>]: never;
} & {
  [K in keyof T & keyof AuthEventHandlerMap]: T[K] extends object
    ? T[K] & {
        [N in Exclude<keyof T[K], keyof NonNullable<AuthEventHandlerMap[K]>>]: never;
      }
    : T[K];
};

function eventRef<const K extends AuthEventKind>(id: K): AuthEventRef<K> {
  return { id, __authEventKind: id };
}

function targetRef<const K extends AuthEventTargetKind>(
  kind: K,
  id: ScopeIdForKind<K>,
): AuthEventTarget<K> {
  return { kind, id, __authEventScope: kind };
}

function compileWhere(where: AuthEventWhereInput): AuthEventWhereFilter {
  const builder = new AuthEventWhereBuilder();
  where(builder);
  return builder.build();
}

function categoryForKind(kind: AuthEventKind): AuthEventCategory {
  return EVENT_KIND_CATEGORY[kind];
}

/**
 * Generate a unique event id.
 *
 * Every emit is a distinct audit record, so the id is unique by construction —
 * the durable stream is fed asynchronously by a single drainer keyed on this
 * id, and the request-path projection dedup only collapses identical
 * caller-supplied keys (e.g. webhook delivery attempts), never distinct emits.
 */
function eventId(event: { kind: AuthEventKind; subject: AuthEventSubject }): string {
  const suffix = generateRandomString(16, "abcdefghijklmnopqrstuvwxyz0123456789");
  return `${event.kind}:${event.subject.type}:${event.subject.id ?? "none"}:${Date.now()}:${suffix}`;
}

export type EmitAuthEventInput<K extends AuthEventKind = AuthEventKind> = {
  eventId?: string;
  category?: AuthEventCategory;
  occurredAt?: number;
  kind: K;
  actor: AuthEventActor;
  subject: AuthEventSubject;
  targets: AuthEventTargetScope[];
  request?: AuthEventRequest;
  outcome: AuthEventOutcome;
  errorCode?: string;
  data?: EventData<K>;
};

type EventConfig = {
  component: AuthComponentApi;
  events?: AuthEventHandlerMap;
};

/** The emit input plus the fields {@link emitAuthEvent} computes when omitted. */
type AuthEventComputed<K extends AuthEventKind> = EmitAuthEventInput<K> & {
  eventId: string;
  category: AuthEventCategory;
  occurredAt: number;
};

/**
 * View a fully-computed event as the kind-correlated {@link AuthEvent}.
 *
 * `AuthEvent<K>` is a distributive conditional that correlates `data` to `kind`;
 * TypeScript cannot construct it positively from the structurally wider computed
 * object. The value is correct by construction and the component re-validates it
 * against `vAuthEvent` on append, so this is the single narrow boundary
 * assertion — a typed target, never `any`.
 */
function finalizeAuthEvent<K extends AuthEventKind>(computed: AuthEventComputed<K>): AuthEvent<K> {
  return computed as AuthEvent<K>;
}

type AuthEventHandlerSelector<K extends AuthEventKind> = (
  handlers: AuthEventHandlerMap,
) => AuthEventHandler<K> | undefined;

/**
 * Single source of truth mapping every {@link AuthEventKind} to the selector
 * that resolves its user-supplied handler from an {@link AuthEventHandlerMap}.
 *
 * Typed as `Record<AuthEventKind, …>` (via `EventHandlerSelectorTable`) so the
 * compiler enforces exactly one entry per kind: a missing kind fails to
 * typecheck rather than silently resolving to no handler. Each selector returns
 * the handler typed to its own kind, so the resolved value is invoked against
 * the matching event with no widening. Kinds with no slot in
 * `AuthEventHandlerMap` map to a selector that returns `undefined`.
 */
type EventHandlerSelectorTable = {
  [K in AuthEventKind]: AuthEventHandlerSelector<K>;
};

const EVENT_HANDLER_SELECTORS: EventHandlerSelectorTable = {
  "user.created": (h) => h.user?.created,
  "user.updated": (h) => h.user?.updated,
  "session.signed_in": (h) => h.session?.signedIn,
  "session.signed_out": (h) => h.session?.signedOut,
  "session.invalidated": (h) => h.session?.invalidated,
  "session.refresh_exchanged": (h) => h.session?.refreshExchanged,
  "session.refresh_reuse_detected": (h) => h.session?.refreshReuseDetected,
  "account.linked": (h) => h.account?.linked,
  "account.unlinked": (h) => h.account?.unlinked,
  "password.changed": (h) => h.password?.changed,
  "passkey.added": (h) => h.passkey?.added,
  "passkey.removed": (h) => h.passkey?.removed,
  "totp.enrolled": (h) => h.totp?.enrolled,
  "totp.removed": (h) => h.totp?.removed,
  "email.verified": (h) => h.email?.verified,
  "phone.verified": (h) => h.phone?.verified,
  "api_key.created": (h) => h.apiKey?.created,
  "api_key.revoked": (h) => h.apiKey?.revoked,
  "oauth.client.created": (h) => h.oauth?.clientCreated,
  "oauth.client.revoked": (h) => h.oauth?.clientRevoked,
  "oauth.code.created": (h) => h.oauth?.codeCreated,
  "oauth.token.created": (h) => h.oauth?.tokenCreated,
  "oauth.token.exchanged": (h) => h.oauth?.tokenExchanged,
  "oauth.refresh.reuse_detected": (h) => h.oauth?.refreshReuseDetected,
  "oauth.refresh.revoked": (h) => h.oauth?.refreshRevoked,
  "connection.created": (h) => h.connection?.connectionCreated,
  "connection.updated": (h) => h.connection?.connectionUpdated,
  "connection.removed": (h) => h.connection?.connectionRemoved,
  "connection.login.succeeded": (h) => h.connection?.loginSucceeded,
  "connection.login.failed": (h) => h.connection?.loginFailed,
  "connection.domain.verification_requested": (h) => h.connection?.domainVerificationRequested,
  "connection.domain.verified": (h) => h.connection?.domainVerified,
  "connection.policy.updated": (h) => h.connection?.policyUpdated,
  "connection.saml.set": (h) => h.connection?.samlSet,
  "connection.saml.refreshed": (h) => h.connection?.samlRefreshed,
  "connection.oidc.set": (h) => h.connection?.oidcSet,
  "connection.scim.set": (h) => h.scim?.set,
  "connection.scim.read": (h) => h.scim?.read,
  "connection.scim.user.provisioned": (h) => h.scim?.userProvisioned,
  "connection.scim.user.updated": (h) => h.scim?.userUpdated,
  "connection.scim.user.deactivated": (h) => h.scim?.userDeactivated,
  "connection.scim.user.reactivated": (h) => h.scim?.userReactivated,
  "connection.scim.group.provisioned": (h) => h.scim?.groupProvisioned,
  "connection.scim.group.updated": (h) => h.scim?.groupUpdated,
  "connection.scim.group.deactivated": (h) => h.scim?.groupDeactivated,
  "connection.scim.group.reactivated": (h) => h.scim?.groupReactivated,
  "webhook.endpoint.created": (h) => h.webhook?.endpointCreated,
  "webhook.endpoint.disabled": (h) => h.webhook?.endpointDisabled,
  "webhook.delivery.created": () => undefined,
  "webhook.delivery.attempted": () => undefined,
  "webhook.delivery.succeeded": () => undefined,
  "webhook.delivery.failed": () => undefined,
};

function selectEventHandler<K extends AuthEventKind>(
  handlers: AuthEventHandlerMap,
  kind: K,
): AuthEventHandler<K> | undefined {
  return EVENT_HANDLER_SELECTORS[kind](handlers);
}

async function runEventHandler(
  ctx: AuthEventCtx,
  handlers: AuthEventHandlerMap | undefined,
  event: AuthEvent,
) {
  if (!handlers) return;
  const handler = selectEventHandler(handlers, event.kind);
  await handler?.(ctx, event);
}

/**
 * Append an auth event to the durable stream and run any matching handler.
 *
 * Fills in `eventId`, `category`, and `occurredAt` when omitted, then writes
 * via the component `event.append` mutation. The configured handler for the
 * event kind runs only when the append created a new record (idempotency).
 *
 * @param ctx - Convex mutation or action context.
 * @param config - Component reference plus optional event handler map.
 * @param input - The event to emit.
 * @returns The append result from the component mutation.
 */
export async function emitAuthEvent<K extends AuthEventKind>(
  ctx: AuthEventCtx,
  config: EventConfig,
  input: EmitAuthEventInput<K>,
) {
  const event = finalizeAuthEvent<K>({
    ...input,
    eventId: input.eventId ?? eventId(input),
    category: input.category ?? categoryForKind(input.kind),
    occurredAt: input.occurredAt ?? Date.now(),
  });
  const result = await ctx.runMutation(config.component.event.append, {
    event,
    targets: event.targets,
    idempotencyKey: event.eventId,
  });
  if (result.created) {
    await runEventHandler(ctx, config.events, event);
  }
  return result;
}

/**
 * Build the `auth.event` namespace for reading and emitting auth events.
 *
 * @param config - Component reference plus optional event handler map.
 * @returns An object with `get`, `list`, and `emit` helpers.
 */
export function createAuthEventDomain(config: EventConfig) {
  return {
    get: async (ctx: AuthEventCtx, args: { id: string }) =>
      await ctx.runQuery(config.component.event.get, args),
    list: async (
      ctx: AuthEventCtx,
      args: {
        where: AuthEventWhereInput;
        order?: "asc" | "desc";
        paginationOpts: PaginationOptions;
      },
    ) =>
      await ctx.runQuery(config.component.event.list, {
        ...args,
        where: compileWhere(args.where),
      }),
    emit: async <K extends AuthEventKind>(ctx: AuthEventCtx, args: EmitAuthEventInput<K>) =>
      await emitAuthEvent(ctx, config, args),
  };
}

/**
 * Typed registry of auth event refs and builders.
 *
 * Provides `eventRef`-typed kinds (e.g. `authEvents.session.signedIn`) plus
 * `target`, `actor`, and `subject` constructors, an exact-checked `handlers`
 * helper, and a `where` filter builder for {@link createAuthEventDomain}'s
 * `list`.
 */
export const authEvents = {
  user: {
    created: eventRef("user.created"),
    updated: eventRef("user.updated"),
  },
  session: {
    signedIn: eventRef("session.signed_in"),
    signedOut: eventRef("session.signed_out"),
    invalidated: eventRef("session.invalidated"),
    refreshExchanged: eventRef("session.refresh_exchanged"),
    refreshReuseDetected: eventRef("session.refresh_reuse_detected"),
  },
  account: {
    linked: eventRef("account.linked"),
    unlinked: eventRef("account.unlinked"),
  },
  password: {
    changed: eventRef("password.changed"),
  },
  passkey: {
    added: eventRef("passkey.added"),
    removed: eventRef("passkey.removed"),
  },
  totp: {
    enrolled: eventRef("totp.enrolled"),
    removed: eventRef("totp.removed"),
  },
  email: {
    verified: eventRef("email.verified"),
  },
  phone: {
    verified: eventRef("phone.verified"),
  },
  apiKey: {
    created: eventRef("api_key.created"),
    revoked: eventRef("api_key.revoked"),
  },
  oauth: {
    clientCreated: eventRef("oauth.client.created"),
    clientRevoked: eventRef("oauth.client.revoked"),
    codeCreated: eventRef("oauth.code.created"),
    tokenCreated: eventRef("oauth.token.created"),
    tokenExchanged: eventRef("oauth.token.exchanged"),
    refreshReuseDetected: eventRef("oauth.refresh.reuse_detected"),
    refreshRevoked: eventRef("oauth.refresh.revoked"),
  },
  connection: {
    connectionCreated: eventRef("connection.created"),
    connectionUpdated: eventRef("connection.updated"),
    connectionRemoved: eventRef("connection.removed"),
    loginSucceeded: eventRef("connection.login.succeeded"),
    loginFailed: eventRef("connection.login.failed"),
    domainVerificationRequested: eventRef("connection.domain.verification_requested"),
    domainVerified: eventRef("connection.domain.verified"),
    policyUpdated: eventRef("connection.policy.updated"),
    samlSet: eventRef("connection.saml.set"),
    samlRefreshed: eventRef("connection.saml.refreshed"),
    oidcSet: eventRef("connection.oidc.set"),
  },
  scim: {
    set: eventRef("connection.scim.set"),
    read: eventRef("connection.scim.read"),
    userProvisioned: eventRef("connection.scim.user.provisioned"),
    userUpdated: eventRef("connection.scim.user.updated"),
    userDeactivated: eventRef("connection.scim.user.deactivated"),
    userReactivated: eventRef("connection.scim.user.reactivated"),
    groupProvisioned: eventRef("connection.scim.group.provisioned"),
    groupUpdated: eventRef("connection.scim.group.updated"),
    groupDeactivated: eventRef("connection.scim.group.deactivated"),
    groupReactivated: eventRef("connection.scim.group.reactivated"),
  },
  webhook: {
    endpointCreated: eventRef("webhook.endpoint.created"),
    endpointDisabled: eventRef("webhook.endpoint.disabled"),
    deliveryCreated: eventRef("webhook.delivery.created"),
    deliveryAttempted: eventRef("webhook.delivery.attempted"),
    deliverySucceeded: eventRef("webhook.delivery.succeeded"),
    deliveryFailed: eventRef("webhook.delivery.failed"),
  },
  target: {
    user: (id: GenericId<"User">) => targetRef("user", id),
    session: (id: GenericId<"Session">) => targetRef("session", id),
    group: (id: GenericId<"Group">) => targetRef("group", id),
    connection: (id: GenericId<"GroupConnection">) => targetRef("connection", id),
    oauthClient: (id: GenericId<"OAuthClient"> | string) => targetRef("oauth_client", id),
    apiKey: (id: GenericId<"ApiKey">) => targetRef("api_key", id),
    security: () => targetRef("global", "security"),
  },
  actor: {
    user: (id: string): AuthEventActor<"user"> => ({ type: "user", id }),
    system: (): AuthEventActor<"system"> => ({ type: "system" }),
    scim: (id?: string): AuthEventActor<"scim"> => ({ type: "scim", id }),
    apiKey: (id: string): AuthEventActor<"api_key"> => ({ type: "api_key", id }),
    oauthClient: (id: string): AuthEventActor<"oauth_client"> => ({ type: "oauth_client", id }),
    webhook: (id: string): AuthEventActor<"webhook"> => ({ type: "webhook", id }),
    anonymous: (): AuthEventActor<"anonymous"> => ({ type: "anonymous" }),
  },
  subject: {
    user: (id: string): AuthEventSubject<"user"> => ({ type: "user", id }),
    session: (id: string): AuthEventSubject<"session"> => ({ type: "session", id }),
    account: (id: string): AuthEventSubject<"account"> => ({ type: "account", id }),
    passkey: (id: string): AuthEventSubject<"passkey"> => ({ type: "passkey", id }),
    totp: (id: string): AuthEventSubject<"totp"> => ({ type: "totp", id }),
    email: (id: string): AuthEventSubject<"email"> => ({ type: "email", id }),
    phone: (id: string): AuthEventSubject<"phone"> => ({ type: "phone", id }),
    apiKey: (id: string): AuthEventSubject<"api_key"> => ({ type: "api_key", id }),
    oauthClient: (id: string): AuthEventSubject<"oauth_client"> => ({
      type: "oauth_client",
      id,
    }),
    oauthCode: (id: string): AuthEventSubject<"oauth_code"> => ({ type: "oauth_code", id }),
    group: (id: string): AuthEventSubject<"group"> => ({ type: "group", id }),
    connection: (id: string): AuthEventSubject<"connection"> => ({ type: "connection", id }),
    scimIdentity: (id: string): AuthEventSubject<"scim_identity"> => ({
      type: "scim_identity",
      id,
    }),
    webhookEndpoint: (id: string): AuthEventSubject<"webhook_endpoint"> => ({
      type: "webhook_endpoint",
      id,
    }),
    webhookDelivery: (id: string): AuthEventSubject<"webhook_delivery"> => ({
      type: "webhook_delivery",
      id,
    }),
    system: (): AuthEventSubject<"system"> => ({ type: "system" }),
  },
  handlers: <const T>(handlers: ExactAuthEventHandlerMap<T> & AuthEventHandlerMap) => handlers,
  where: (build: (q: AuthEventWhereBuilderShape) => AuthEventWhereBuilderShape) =>
    compileWhere(build),
} as const;
