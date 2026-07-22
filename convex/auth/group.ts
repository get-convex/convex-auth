import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { api } from "../_generated/api";
import { query } from "../_generated/server";
import { auth } from "../auth";
import { auth as authCore } from "../auth/core";
import { ErrorCode } from "../errors";
import { authAction, authMutation, authQuery } from "../functions";
import { roles } from "../roles";

const vConnectionStatus = v.union(v.literal("draft"), v.literal("active"), v.literal("disabled"));
const vAuthEventKind = v.union(
  v.literal("user.created"),
  v.literal("user.updated"),
  v.literal("session.signed_in"),
  v.literal("session.signed_out"),
  v.literal("session.invalidated"),
  v.literal("session.refresh_exchanged"),
  v.literal("session.refresh_reuse_detected"),
  v.literal("account.linked"),
  v.literal("account.unlinked"),
  v.literal("password.changed"),
  v.literal("passkey.added"),
  v.literal("passkey.removed"),
  v.literal("totp.enrolled"),
  v.literal("totp.removed"),
  v.literal("email.verified"),
  v.literal("phone.verified"),
  v.literal("api_key.created"),
  v.literal("api_key.revoked"),
  v.literal("oauth.client.created"),
  v.literal("oauth.client.revoked"),
  v.literal("oauth.code.created"),
  v.literal("oauth.token.created"),
  v.literal("oauth.token.exchanged"),
  v.literal("oauth.refresh.reuse_detected"),
  v.literal("oauth.refresh.revoked"),
  v.literal("connection.created"),
  v.literal("connection.updated"),
  v.literal("connection.removed"),
  v.literal("connection.login.succeeded"),
  v.literal("connection.login.failed"),
  v.literal("connection.domain.verification_requested"),
  v.literal("connection.domain.verified"),
  v.literal("connection.policy.updated"),
  v.literal("connection.saml.set"),
  v.literal("connection.saml.refreshed"),
  v.literal("connection.oidc.set"),
  v.literal("connection.scim.set"),
  v.literal("connection.scim.read"),
  v.literal("connection.scim.user.provisioned"),
  v.literal("connection.scim.user.updated"),
  v.literal("connection.scim.user.deactivated"),
  v.literal("connection.scim.user.reactivated"),
  v.literal("connection.scim.group.provisioned"),
  v.literal("connection.scim.group.updated"),
  v.literal("connection.scim.group.deactivated"),
  v.literal("connection.scim.group.reactivated"),
  v.literal("webhook.endpoint.created"),
  v.literal("webhook.endpoint.disabled"),
  v.literal("webhook.delivery.created"),
  v.literal("webhook.delivery.attempted"),
  v.literal("webhook.delivery.succeeded"),
  v.literal("webhook.delivery.failed"),
);

const vConnectionWhere = v.object({
  groupId: v.optional(v.string()),
  slug: v.optional(v.string()),
  status: v.optional(vConnectionStatus),
});

const vDomainInput = v.object({
  domain: v.string(),
  isPrimary: v.optional(v.boolean()),
});

const vDomainVerificationInput = {
  connectionId: v.string(),
  domain: v.string(),
};

const vSamlAttributeMapping = v.object({
  subject: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  image: v.optional(v.string()),
  groups: v.optional(v.string()),
  roles: v.optional(v.string()),
});

const vSamlSecurity = v.object({
  requireSignedAssertions: v.optional(v.boolean()),
  requireTimestamps: v.optional(v.boolean()),
  clockSkewSeconds: v.optional(v.number()),
  weakAlgorithmHandling: v.optional(v.union(v.literal("warn"), v.literal("reject"))),
  maxMetadataSize: v.optional(v.number()),
  maxResponseSize: v.optional(v.number()),
});

const vSamlServiceProvider = v.object({
  entityId: v.optional(v.string()),
  acsUrl: v.optional(v.string()),
  sloUrl: v.optional(v.string()),
  signingCert: v.optional(v.union(v.string(), v.array(v.string()))),
  encryptCert: v.optional(v.union(v.string(), v.array(v.string()))),
  privateKey: v.optional(v.string()),
  privateKeyPass: v.optional(v.string()),
  encPrivateKey: v.optional(v.string()),
  encPrivateKeyPass: v.optional(v.string()),
});

const vPolicyPatch = v.object({
  identity: v.optional(
    v.object({
      accountLinking: v.optional(
        v.object({
          oidc: v.optional(
            v.union(v.literal("verifiedEmail"), v.literal("none"), v.literal("sameConnection")),
          ),
          saml: v.optional(
            v.union(v.literal("verifiedEmail"), v.literal("none"), v.literal("sameConnection")),
          ),
        }),
      ),
    }),
  ),
  provisioning: v.optional(
    v.object({
      user: v.optional(
        v.object({
          createOnSignIn: v.optional(v.boolean()),
          updateProfileOnLogin: v.optional(
            v.union(v.literal("never"), v.literal("missing"), v.literal("always")),
          ),
          updateProfileFromScim: v.optional(
            v.union(v.literal("never"), v.literal("missing"), v.literal("always")),
          ),
          authority: v.optional(
            v.union(v.literal("app"), v.literal("connection"), v.literal("scim")),
          ),
        }),
      ),
      scimReuse: v.optional(
        v.object({
          user: v.optional(v.union(v.literal("externalId"), v.literal("none"))),
        }),
      ),
      jit: v.optional(
        v.object({
          mode: v.optional(
            v.union(
              v.literal("off"),
              v.literal("createUser"),
              v.literal("createUserAndMembership"),
            ),
          ),
          defaultRoleIds: v.optional(v.array(v.string())),
        }),
      ),
      deprovision: v.optional(
        v.object({
          mode: v.optional(v.union(v.literal("soft"), v.literal("hard"))),
        }),
      ),
      groups: v.optional(
        v.object({
          mode: v.optional(v.union(v.literal("ignore"), v.literal("sync"))),
          source: v.optional(v.literal("protocol")),
          mapping: v.optional(v.record(v.string(), v.array(v.string()))),
        }),
      ),
      roles: v.optional(
        v.object({
          mode: v.optional(v.union(v.literal("ignore"), v.literal("map"))),
          source: v.optional(v.literal("protocol")),
          mapping: v.optional(v.record(v.string(), v.array(v.string()))),
        }),
      ),
    }),
  ),
});

const vOidcConfigure = {
  connectionId: v.string(),
  discovery: v.object({
    issuer: v.optional(v.string()),
    discoveryUrl: v.optional(v.string()),
    jwksUri: v.optional(v.string()),
    audience: v.optional(v.union(v.string(), v.array(v.string()))),
  }),
  client: v.object({
    id: v.string(),
    secret: v.optional(v.string()),
    authMethod: v.optional(
      v.union(v.literal("client_secret_post"), v.literal("client_secret_basic")),
    ),
  }),
  request: v.optional(
    v.object({
      scopes: v.optional(v.array(v.string())),
      loginHint: v.optional(v.string()),
      authorizationParams: v.optional(v.record(v.string(), v.string())),
    }),
  ),
  security: v.optional(
    v.object({
      clockToleranceSeconds: v.optional(v.number()),
      strictIssuer: v.optional(v.boolean()),
    }),
  ),
  profile: v.optional(
    v.object({
      mapping: v.optional(
        v.object({
          subject: v.optional(v.string()),
          email: v.optional(v.string()),
          emailVerified: v.optional(v.string()),
          name: v.optional(v.string()),
          image: v.optional(v.string()),
          groups: v.optional(v.string()),
          roles: v.optional(v.string()),
        }),
      ),
      extraFields: v.optional(v.record(v.string(), v.string())),
    }),
  ),
};

const vSamlConfigure = {
  connectionId: v.string(),
  metadata: v.object({
    xml: v.optional(v.string()),
    url: v.optional(v.string()),
  }),
  domains: v.optional(v.array(v.string())),
  request: v.optional(
    v.object({
      signAuthnRequests: v.optional(v.boolean()),
      nameIdFormat: v.optional(v.string()),
      forceAuthn: v.optional(v.boolean()),
      authnContextClassRefs: v.optional(v.array(v.string())),
    }),
  ),
  profile: v.optional(
    v.object({
      mapping: v.optional(vSamlAttributeMapping),
      extraFields: v.optional(v.record(v.string(), v.string())),
    }),
  ),
  security: v.optional(vSamlSecurity),
  serviceProvider: v.optional(vSamlServiceProvider),
};

const vScimConfigure = {
  connectionId: v.string(),
  status: v.optional(vConnectionStatus),
  security: v.optional(
    v.object({
      maxRequestSize: v.optional(v.number()),
    }),
  ),
  profile: v.optional(
    v.object({
      mapping: v.optional(
        v.object({
          subject: v.optional(v.string()),
          externalId: v.optional(v.string()),
          email: v.optional(v.string()),
          firstName: v.optional(v.string()),
          lastName: v.optional(v.string()),
          name: v.optional(v.string()),
          phone: v.optional(v.string()),
          active: v.optional(v.string()),
          groups: v.optional(v.string()),
          roles: v.optional(v.string()),
        }),
      ),
      extraFields: v.optional(v.record(v.string(), v.string())),
    }),
  ),
};

async function requireGroupAdmin(
  ctx: Parameters<typeof authCore.member.assert>[0] & { auth: { userId: string } },
  groupId: string,
) {
  await authCore.member.assert(ctx, {
    userId: ctx.auth.userId,
    groupId,
    roleIds: [roles.orgAdmin.id],
  });
}

async function resolveConnectionGroup(
  ctx: Parameters<typeof auth.connection.get>[0],
  connectionId: string,
): Promise<string> {
  const connection = await auth.connection.get(ctx, { id: connectionId });
  if (connection === null) {
    throw new ConvexError({
      code: ErrorCode.INVALID_PARAMETERS,
      message: "Connection not found.",
    });
  }
  return connection.groupId;
}

export const createConnection = authMutation({
  args: {
    groupId: v.string(),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    protocol: v.union(v.literal("oidc"), v.literal("saml")),
    status: v.optional(vConnectionStatus),
    domain: v.optional(v.string()),
  },
  returns: auth.v.connection.created,
  handler: async (ctx, args) => {
    await requireGroupAdmin(ctx, args.groupId);
    const created = await auth.connection.create(ctx, {
      groupId: args.groupId,
      name: args.name,
      slug: args.slug,
      protocol: args.protocol,
      status: args.status,
    });
    if (args.domain) {
      await auth.connection.domain.upsert(ctx, {
        connectionId: created.connectionId,
        domains: [{ domain: args.domain, isPrimary: true }],
      });
    }
    return { ...created, groupId: args.groupId };
  },
});

export const getConnection = authQuery({
  args: { id: v.string() },
  returns: v.union(auth.v.connection.doc, v.null()),
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.id);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.get(ctx, { id: args.id });
  },
});

export const getConnectionByDomain = authQuery({
  args: { domain: v.string() },
  returns: auth.v.connection.lookup,
  handler: async (ctx, args) => {
    const resolved = await auth.connection.get(ctx, { domain: args.domain });
    if (resolved?.connection == null) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Connection not found.",
      });
    }
    await requireGroupAdmin(ctx, resolved.connection.groupId);
    return resolved;
  },
});

export const listConnections = authQuery({
  args: {
    where: v.optional(vConnectionWhere),
    paginationOpts: paginationOptsValidator,
    orderBy: v.optional(
      v.union(
        v.literal("_creationTime"),
        v.literal("name"),
        v.literal("slug"),
        v.literal("status"),
      ),
    ),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: auth.v.list(auth.v.connection.doc),
  handler: async (ctx, args) => {
    if (!args.where?.groupId) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Group scope required.",
      });
    }
    await requireGroupAdmin(ctx, args.where.groupId);
    return auth.connection.list(ctx, {
      where: args.where,
      paginationOpts: args.paginationOpts,
      orderBy: args.orderBy,
      order: args.order,
    });
  },
});

export const updateConnection = authMutation({
  args: {
    id: v.string(),
    patch: v.object({
      name: v.optional(v.string()),
      slug: v.optional(v.string()),
      status: v.optional(vConnectionStatus),
    }),
  },
  returns: auth.v.connection.id,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.id);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.update(ctx, { id: args.id, patch: args.patch });
  },
});

export const removeConnection = authMutation({
  args: { id: v.string() },
  returns: auth.v.connection.id,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.id);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.remove(ctx, { id: args.id });
  },
});

export const getConnectionStatus = authQuery({
  args: { id: v.string() },
  returns: auth.v.connection.status,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.id);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.status(ctx, { id: args.id });
  },
});

export const listDomains = authQuery({
  args: { connectionId: v.string() },
  returns: v.array(auth.v.connection.domain.doc),
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.domain.list(ctx, { connectionId: args.connectionId });
  },
});

export const validateDomains = authQuery({
  args: { connectionId: v.string() },
  returns: auth.v.connection.domain.validation,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.domain.validate(ctx, { connectionId: args.connectionId });
  },
});

export const setDomains = authMutation({
  args: {
    connectionId: v.string(),
    domains: v.array(vDomainInput),
  },
  returns: auth.v.connection.domain.upsert,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.domain.upsert(ctx, {
      connectionId: args.connectionId,
      domains: args.domains,
    });
  },
});

export const requestDomainVerification = authMutation({
  args: vDomainVerificationInput,
  returns: auth.v.connection.domain.verificationRequest,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.domain.verification.request(ctx, args);
  },
});

export const confirmDomainVerification = authAction({
  args: vDomainVerificationInput,
  returns: auth.v.connection.domain.verificationConfirm,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.domain.verification.confirm(ctx, args);
  },
});

export const setOidc = authMutation({
  args: vOidcConfigure,
  returns: auth.v.connection.oidc.config,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.oidc.upsert(ctx, args);
  },
});

export const getOidc = authQuery({
  args: { connectionId: v.string() },
  returns: auth.v.connection.oidc.config,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.oidc.get(ctx, { connectionId: args.connectionId });
  },
});

export const validateOidc = authAction({
  args: { connectionId: v.string() },
  returns: auth.v.connection.oidc.validation,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.oidc.validate(ctx, { connectionId: args.connectionId });
  },
});

export const setSaml = authAction({
  args: vSamlConfigure,
  returns: auth.v.connection.created,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.saml.upsert(ctx, args);
  },
});

export const validateSaml = authQuery({
  args: { connectionId: v.string() },
  returns: auth.v.connection.saml.validation,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.saml.validate(ctx, { connectionId: args.connectionId });
  },
});

export const getPolicy = authQuery({
  args: { groupId: v.string() },
  returns: auth.v.connection.policy.config,
  handler: async (ctx, args) => {
    await requireGroupAdmin(ctx, args.groupId);
    return auth.connection.policy.get(ctx, { groupId: args.groupId });
  },
});

export const updatePolicy = authMutation({
  args: {
    groupId: v.string(),
    patch: vPolicyPatch,
  },
  returns: auth.v.connection.policy.config,
  handler: async (ctx, args) => {
    await requireGroupAdmin(ctx, args.groupId);
    return auth.connection.policy.update(ctx, { groupId: args.groupId, patch: args.patch });
  },
});

export const validatePolicy = authQuery({
  args: { groupId: v.string() },
  returns: auth.v.connection.policy.validation,
  handler: async (ctx, args) => {
    await requireGroupAdmin(ctx, args.groupId);
    return auth.connection.policy.validate(ctx, { groupId: args.groupId });
  },
});

export const listAudit = authQuery({
  args: {
    groupId: v.optional(v.string()),
    connectionId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: auth.v.list(auth.v.connection.audit.event),
  handler: async (ctx, args) => {
    const groupId =
      args.groupId ??
      (args.connectionId ? await resolveConnectionGroup(ctx, args.connectionId) : undefined);
    if (!groupId) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Group scope required.",
      });
    }
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.audit.list(ctx, {
      groupId: args.groupId,
      connectionId: args.connectionId,
      paginationOpts: args.paginationOpts,
    });
  },
});

export const createWebhookEndpoint = authMutation({
  args: {
    connectionId: v.string(),
    url: v.string(),
    secret: v.string(),
    subscriptions: v.array(vAuthEventKind),
  },
  returns: auth.v.connection.webhook.endpoint,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    const userId = ctx.auth.userId;
    const result = await auth.connection.webhook.endpoint.create(ctx, {
      connectionId: args.connectionId,
      url: args.url,
      secret: args.secret,
      subscriptions: args.subscriptions,
      createdByUserId: userId,
    });
    const endpoint = await auth.connection.webhook.endpoint.get(ctx, {
      id: result.endpointId,
    });
    if (endpoint === null) {
      throw new ConvexError({
        code: ErrorCode.INTERNAL_ERROR,
        message: "Created webhook endpoint could not be loaded.",
      });
    }
    return endpoint;
  },
});

export const listWebhookEndpoints = authQuery({
  args: { connectionId: v.string() },
  returns: v.array(auth.v.connection.webhook.endpoint),
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.webhook.endpoint.list(ctx, {
      connectionId: args.connectionId,
    });
  },
});

export const listWebhookDeliveries = authQuery({
  args: {
    connectionId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: auth.v.list(auth.v.connection.webhook.delivery),
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.webhook.delivery.list(ctx, {
      connectionId: args.connectionId,
      paginationOpts: args.paginationOpts,
    });
  },
});

export const disableWebhookEndpoint = authMutation({
  args: { id: v.string() },
  returns: auth.v.connection.webhook.disabled,
  handler: async (ctx, args) => {
    const endpoint = await auth.connection.webhook.endpoint.get(ctx, { id: args.id });
    if (!endpoint) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Webhook endpoint not found.",
      });
    }
    await requireGroupAdmin(ctx, endpoint.groupId);
    return auth.connection.webhook.endpoint.revoke(ctx, { id: args.id });
  },
});

export const setScim = authMutation({
  args: vScimConfigure,
  returns: auth.v.connection.scim.upsert,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.scim.upsert(ctx, args);
  },
});

export const getScim = authQuery({
  args: { connectionId: v.string() },
  returns: v.union(auth.v.connection.scim.config, v.null()),
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.scim.get(ctx, { connectionId: args.connectionId });
  },
});

export const validateScim = authQuery({
  args: { connectionId: v.string() },
  returns: auth.v.connection.scim.validation,
  handler: async (ctx, args) => {
    const groupId = await resolveConnectionGroup(ctx, args.connectionId);
    await requireGroupAdmin(ctx, groupId);
    return auth.connection.scim.validate(ctx, { connectionId: args.connectionId });
  },
});

export const signIn = query({
  args: {
    connectionId: v.optional(v.string()),
    email: v.optional(v.string()),
    domain: v.optional(v.string()),
    redirectTo: v.optional(v.string()),
    loginHint: v.optional(v.string()),
  },
  returns: auth.v.connection.signIn,
  handler: async (ctx, args) => {
    return auth.connection.signIn(ctx, args);
  },
});

export const metadata = query({
  args: {
    connectionId: v.string(),
    entityId: v.optional(v.string()),
    acsUrl: v.optional(v.string()),
    sloUrl: v.optional(v.string()),
  },
  returns: auth.v.connection.saml.metadata,
  handler: async (ctx, args) => {
    return auth.connection.metadata(ctx, args);
  },
});

export const signInLookup = query({
  args: {
    email: v.optional(v.string()),
    domain: v.optional(v.string()),
    redirectTo: v.optional(v.string()),
    loginHint: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      connectionId: v.string(),
      providerId: v.string(),
      protocol: v.union(v.literal("oidc"), v.literal("saml")),
      signInPath: v.string(),
      callbackPath: v.string(),
      redirectTo: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{
    connectionId: string;
    providerId: string;
    protocol: "oidc" | "saml";
    signInPath: string;
    callbackPath: string;
    redirectTo?: string;
  } | null> => {
    try {
      return (await ctx.runQuery(api.auth.group.signIn, args)) as {
        connectionId: string;
        providerId: string;
        protocol: "oidc" | "saml";
        signInPath: string;
        callbackPath: string;
        redirectTo?: string;
      } | null;
    } catch (error) {
      if (
        error instanceof ConvexError &&
        error.data?.code === "INVALID_PARAMETERS" &&
        error.data?.message === "No group connection matched the provided input."
      ) {
        return null;
      }
      throw error;
    }
  },
});
