import type { ComponentCtx as ComponentWriteCtx, ComponentReadCtx } from "./component/context";
import { cached, invalidateCtxCache } from "./cache/context";
import type { AuthEventKind } from "./events";
import type { ConvexAuthMaterializedConfig } from "./types";

type ComponentConnection = ConvexAuthMaterializedConfig["component"]["connection"];
type ComponentUser = ConvexAuthMaterializedConfig["component"]["user"];

/**
 * The loose `runQuery`/`runMutation` casts are centralized in
 * {@link componentQuery} and {@link componentMutation} as a local convenience at
 * this boundary, letting domain code work with typed records inward.
 */
type ComponentBoundaryRunQuery = <TArgs extends Record<string, unknown>, TResult>(
  ref: unknown,
  args: TArgs,
) => Promise<TResult>;
type ComponentBoundaryRunMutation = <TArgs extends Record<string, unknown>, TResult>(
  ref: unknown,
  args: TArgs,
) => Promise<TResult>;

type GroupConnectionRecord = {
  _id: string;
  _creationTime: number;
  groupId: string;
  slug?: string;
  name?: string;
  protocol: "oidc" | "saml";
  status: "draft" | "active" | "disabled";
  config?: unknown;
  extend?: unknown;
};

type GroupConnectionDomainLookupRecord = {
  connection: GroupConnectionRecord | null;
  domain: ConnectionDomainRecord | null;
};

type PaginatedResult<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
};

type PaginationOpts = {
  numItems: number;
  cursor: string | null;
};

type GroupRecord = {
  _id: string;
  _creationTime: number;
  name: string;
  slug?: string;
  type?: string;
  parentGroupId?: string;
  rootGroupId?: string;
  isRoot?: boolean;
  policy?: unknown;
  extend?: unknown;
};

type ConnectionDomainRecord = {
  _id: string;
  _creationTime: number;
  connectionId: string;
  groupId: string;
  domain: string;
  isPrimary: boolean;
  verifiedAt?: number;
};

type ConnectionDomainVerificationRecord = {
  domainId: string;
  recordName: string;
  token: string;
  expiresAt: number;
};

type ScimConfigRecord = {
  _id: string;
  _creationTime: number;
  connectionId: string;
  groupId: string;
  status: "draft" | "active" | "disabled";
  basePath: string;
  tokenHash: string;
  lastRotatedAt?: number;
  extend?: unknown;
};

type GroupConnectionSecretRecord = {
  ciphertext: string;
};

type WebhookEndpointRecord = {
  _id: string;
  _creationTime: number;
  connectionId: string;
  groupId: string;
  url: string;
  status: "active" | "disabled";
  secretCiphertext?: string;
  /** @deprecated One-way legacy hash; never expose through a public facade. */
  secretHash?: string;
  subscriptions: string[];
  createdByUserId?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureCount: number;
  extend?: unknown;
};

type WebhookDeliveryRecord = {
  _id: string;
  _creationTime: number;
  connectionId: string;
  endpointId: string;
  eventId: string;
  kind: AuthEventKind;
  status: "pending" | "processing" | "delivered" | "failed";
  attemptCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastResponseStatus?: number;
  lastError?: string;
  signedAt: number;
};

type InternalWebhookDeliveryRecord = WebhookDeliveryRecord & {
  payload: unknown;
  signature: string;
};

export type ScimIdentityRecord = {
  _id: string;
  _creationTime: number;
  connectionId: string;
  groupId: string;
  resourceType: string;
  externalId: string;
  userId?: string;
  mappedGroupId?: string;
  active?: boolean;
  raw?: Record<string, unknown>;
  lastProvisionedAt?: number;
};

const componentQuery = <TArgs extends Record<string, unknown>, TResult>(
  ctx: ComponentReadCtx,
  ref: unknown,
  args: TArgs,
) => (ctx.runQuery as ComponentBoundaryRunQuery)(ref, args) as Promise<TResult>;

const componentMutation = <TArgs extends Record<string, unknown>, TResult>(
  ctx: ComponentWriteCtx,
  ref: unknown,
  args: TArgs,
) => (ctx.runMutation as ComponentBoundaryRunMutation)(ref, args) as Promise<TResult>;

export const getGroupConnection = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  connectionId: string,
) =>
  cached(ctx, `group-connection:${connectionId}`, () =>
    componentQuery<{ id: string }, GroupConnectionRecord | null>(ctx, componentConnection.get, {
      id: connectionId,
    }),
  );

export const getGroupConnectionByDomain = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  domain: string,
) =>
  cached(ctx, `group-connection-domain:${domain}`, () =>
    componentQuery<{ domain: string }, GroupConnectionDomainLookupRecord | null>(
      ctx,
      componentConnection.get,
      { domain },
    ),
  );

export const listGroupConnections = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  args: {
    where?: {
      groupId?: string;
      slug?: string;
      status?: "draft" | "active" | "disabled";
    };
    paginationOpts: PaginationOpts;
    orderBy?: "_creationTime" | "name" | "slug" | "status";
    order?: "asc" | "desc";
  },
) =>
  componentQuery<typeof args, PaginatedResult<GroupConnectionRecord>>(
    ctx,
    componentConnection.list,
    args,
  );

export const createGroupConnection = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    groupId: string;
    protocol: "oidc" | "saml";
    slug?: string;
    name?: string;
    status?: "draft" | "active" | "disabled";
    config?: Record<string, unknown>;
    extend?: Record<string, unknown>;
  },
) => componentMutation<typeof args, string>(ctx, componentConnection.create, args);

export const updateGroupConnection = async (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: { connectionId: string; patch: Record<string, unknown> },
) => {
  const result = await componentMutation<{ id: string; patch: Record<string, unknown> }, null>(
    ctx,
    componentConnection.update,
    { id: args.connectionId, patch: args.patch },
  );
  invalidateCtxCache(ctx, `group-connection:${args.connectionId}`);
  invalidateCtxCache(ctx, "group-connection-domain");
  return result;
};

export const removeGroupConnection = async (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  connectionId: string,
) => {
  const result = await componentMutation<{ id: string }, null>(ctx, componentConnection.remove, {
    id: connectionId,
  });
  invalidateCtxCache(ctx, `group-connection:${connectionId}`);
  invalidateCtxCache(ctx, "group-connection-domain");
  invalidateCtxCache(ctx, `connection-domains:${connectionId}`);
  invalidateCtxCache(ctx, "group-connection-secret");
  return result;
};

export const getGroup = (
  ctx: ComponentReadCtx,
  componentGroup: ConvexAuthMaterializedConfig["component"]["group"],
  groupId: string,
) =>
  cached(ctx, `group-record:${groupId}`, () =>
    componentQuery<{ id: string }, GroupRecord | null>(ctx, componentGroup.get, { id: groupId }),
  );

export const listConnectionDomains = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  connectionId: string,
) =>
  cached(ctx, `connection-domains:${connectionId}`, () =>
    componentQuery<{ connectionId: string }, ConnectionDomainRecord[]>(
      ctx,
      componentConnection.domain.list,
      { connectionId },
    ),
  );

export const createConnectionDomain = async (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    groupId: string;
    domain: string;
    isPrimary?: boolean;
  },
) => {
  const result = await componentMutation<typeof args, string>(
    ctx,
    componentConnection.domain.create,
    args,
  );
  invalidateCtxCache(ctx, `connection-domains:${args.connectionId}`);
  invalidateCtxCache(ctx, "group-connection-domain");
  return result;
};

export const removeConnectionDomain = async (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  domainId: string,
) => {
  const result = await componentMutation<{ id: string }, null>(
    ctx,
    componentConnection.domain.remove,
    {
      id: domainId,
    },
  );
  invalidateCtxCache(ctx, "connection-domains");
  invalidateCtxCache(ctx, "group-connection-domain");
  return result;
};

export const getScimConfigByConnection = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  connectionId: string,
) =>
  cached(ctx, `scim-config-by-connection:${connectionId}`, () =>
    componentQuery<{ connectionId: string }, ScimConfigRecord | null>(
      ctx,
      componentConnection.scim.config.get,
      { connectionId },
    ),
  );

export const getScimConfigByTokenHash = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  tokenHash: string,
) =>
  componentQuery<{ tokenHash: string }, ScimConfigRecord | null>(
    ctx,
    componentConnection.scim.config.get,
    { tokenHash },
  );

export const upsertScimConfig = async (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    groupId: string;
    status: string;
    basePath: string;
    tokenHash: string;
    // Optional to match the component `scim.config.upsert` validator
    // (`lastRotatedAt: v.optional(v.number())`).
    lastRotatedAt?: number;
    extend?: unknown;
  },
) => {
  const result = await componentMutation<typeof args, string>(
    ctx,
    componentConnection.scim.config.upsert,
    args,
  );
  invalidateCtxCache(ctx, `scim-config-by-connection:${args.connectionId}`);
  return result;
};

export const getConnectionDomainVerification = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  domainId: string,
) =>
  componentQuery<{ domainId: string }, ConnectionDomainVerificationRecord | null>(
    ctx,
    componentConnection.domain.verification.get,
    { domainId },
  );

export const upsertConnectionDomainVerification = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    groupId: string;
    domainId: string;
    domain: string;
    recordName: string;
    token: string;
    tokenHash: string;
    requestedAt: number;
    expiresAt: number;
  },
) =>
  // The component `domain.verification.upsert` returns the verification-record
  // id (`v.id("GroupConnectionDomainVerification")`), not `null`.
  componentMutation<typeof args, string>(ctx, componentConnection.domain.verification.upsert, args);

export const removeConnectionDomainVerification = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  domainId: string,
) =>
  componentMutation<{ domainId: string }, null>(
    ctx,
    componentConnection.domain.verification.remove,
    {
      domainId,
    },
  );

export const verifyConnectionDomain = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: { domainId: string; verifiedAt: number },
) =>
  // The component `domain.verify` returns the updated domain doc
  // (`vGroupConnectionDomainDoc`), not `null`.
  componentMutation<{ id: string; verifiedAt: number }, ConnectionDomainRecord>(
    ctx,
    componentConnection.domain.verify,
    {
      id: args.domainId,
      verifiedAt: args.verifiedAt,
    },
  );

export const getGroupConnectionSecret = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  args: { connectionId: string; kind: string },
) =>
  cached(ctx, `group-connection-secret:${args.connectionId}:${args.kind}`, () =>
    componentQuery<typeof args, GroupConnectionSecretRecord | null>(
      ctx,
      componentConnection.secret.get,
      args,
    ),
  );

export const upsertGroupConnectionSecret = async (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    groupId: string;
    kind: string;
    ciphertext: string;
    updatedAt: number;
  },
) => {
  // The component `secret.upsert` returns the secret-record id
  // (`v.id("GroupConnectionSecret")`), not `null`.
  const result = await componentMutation<typeof args, string>(
    ctx,
    componentConnection.secret.upsert,
    args,
  );
  invalidateCtxCache(ctx, `group-connection-secret:${args.connectionId}:${args.kind}`);
  return result;
};

export const listWebhookEndpoints = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  connectionId: string,
) =>
  componentQuery<{ connectionId: string }, WebhookEndpointRecord[]>(
    ctx,
    componentConnection.webhook.endpoint.list,
    { connectionId },
  );

export const listWebhookDeliveries = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    paginationOpts: PaginationOpts;
  },
) =>
  componentQuery<typeof args, PaginatedResult<WebhookDeliveryRecord>>(
    ctx,
    componentConnection.webhook.delivery.list,
    args,
  );

/** Upper bound on SCIM identities materialized into the per-connection lookup map. */
const SCIM_IDENTITY_COLLECT_LIMIT = 10_000;

export const listScimIdentitiesByConnection = async (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  connectionId: string,
): Promise<ScimIdentityRecord[]> => {
  const identities: ScimIdentityRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: PaginatedResult<ScimIdentityRecord> = await componentQuery<
      { connectionId: string; paginationOpts: PaginationOpts },
      PaginatedResult<ScimIdentityRecord>
    >(ctx, componentConnection.scim.identity.list, {
      connectionId,
      paginationOpts: { numItems: 200, cursor },
    });
    identities.push(...result.page);
    if (result.isDone || identities.length >= SCIM_IDENTITY_COLLECT_LIMIT) break;
    cursor = result.continueCursor;
  }
  return identities;
};

export const getScimIdentityByConnectionAndUser = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  args: { connectionId: string; userId: string },
) =>
  componentQuery<typeof args, ScimIdentityRecord | null>(
    ctx,
    componentConnection.scim.identity.get,
    args,
  );

export const getScimIdentityByMappedGroup = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  mappedGroupId: string,
) =>
  componentQuery<{ mappedGroupId: string }, ScimIdentityRecord | null>(
    ctx,
    componentConnection.scim.identity.get,
    { mappedGroupId },
  );

export const upsertScimIdentity = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    groupId: string;
    resourceType: string;
    externalId: string;
    userId?: string;
    mappedGroupId?: string;
    active?: boolean;
    raw?: Record<string, unknown>;
    lastProvisionedAt?: number;
  },
) => componentMutation<typeof args, string>(ctx, componentConnection.scim.identity.upsert, args);

export const provisionScimUser = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    groupId: string;
    externalId: string;
    provider: string;
    userData: Record<string, unknown>;
    active?: boolean;
    raw?: Record<string, unknown>;
    lastProvisionedAt?: number;
  },
) =>
  componentMutation<typeof args, { userId: string; created: boolean }>(
    ctx,
    (
      componentConnection.scim.identity as typeof componentConnection.scim.identity & {
        provision: unknown;
      }
    ).provision,
    args,
  );

export const removeScimIdentity = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  identityId: string,
) =>
  componentMutation<{ id: string }, null>(ctx, componentConnection.scim.identity.remove, {
    id: identityId,
  });

export const insertUser = (
  ctx: ComponentWriteCtx,
  componentUser: ComponentUser,
  data: Record<string, unknown>,
) =>
  componentMutation<{ data: Record<string, unknown> }, string>(ctx, componentUser.create, { data });

export const updateUser = (
  ctx: ComponentWriteCtx,
  componentUser: ComponentUser,
  args: { userId: string; patch: Record<string, unknown> },
) =>
  componentMutation<{ id: string; patch: Record<string, unknown> }, null>(
    ctx,
    componentUser.update,
    {
      id: args.userId,
      patch: args.patch,
    },
  );

export const getScimIdentity = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    resourceType: "user" | "group";
    externalId: string;
  },
) =>
  componentQuery<typeof args, ScimIdentityRecord | null>(
    ctx,
    componentConnection.scim.identity.get,
    args,
  );

export const getWebhookEndpoint = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  endpointId: string,
) =>
  componentQuery<{ id: string }, WebhookEndpointRecord | null>(
    ctx,
    componentConnection.webhook.endpoint.get,
    {
      id: endpointId,
    },
  );

export const createWebhookEndpoint = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: {
    connectionId: string;
    groupId: string;
    url: string;
    secretCiphertext: string;
    subscriptions: AuthEventKind[];
    createdByUserId?: string;
  },
) => componentMutation<typeof args, string>(ctx, componentConnection.webhook.endpoint.create, args);

export const updateWebhookEndpoint = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: { endpointId: string; patch: Record<string, unknown> },
) =>
  componentMutation<{ id: string; patch: Record<string, unknown> }, null>(
    ctx,
    componentConnection.webhook.endpoint.update,
    { id: args.endpointId, patch: args.patch },
  );

export const listReadyWebhookDeliveries = (
  ctx: ComponentReadCtx,
  componentConnection: ComponentConnection,
  args: { now: number; limit?: number },
) =>
  componentQuery<typeof args, InternalWebhookDeliveryRecord[]>(
    ctx,
    componentConnection.webhook.delivery.dueForDispatch,
    args,
  );

export const updateWebhookDelivery = (
  ctx: ComponentWriteCtx,
  componentConnection: ComponentConnection,
  args: { deliveryId: string; patch: Record<string, unknown> },
) =>
  componentMutation<{ id: string; patch: Record<string, unknown> }, null>(
    ctx,
    componentConnection.webhook.delivery.update,
    { id: args.deliveryId, patch: args.patch },
  );
