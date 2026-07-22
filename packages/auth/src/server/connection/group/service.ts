import { hmac } from "@oslojs/crypto/hmac";
import { SHA256 } from "@oslojs/crypto/sha2";
import { encodeHexLowerCase } from "@oslojs/encoding";

import { ErrorCode } from "../../../shared/codes";
import { constantTimeEqualHex } from "../../../shared/compare";
import type { ComponentCtx, ComponentReadCtx } from "../../component/context";
import { configDefaults } from "../../config";
import {
  getGroupConnectionSecret as queryGroupConnectionSecret,
  getGroup,
  getGroupConnection,
  getScimConfigByConnection,
  listWebhookEndpoints,
} from "../../contract";
import { convexError } from "../../errors";
import {
  emitAuthEvent,
  type AuthEventDataByKind,
  type AuthEventActor,
  type AuthEventKind,
  type AuthEventObject,
  type AuthEventOutcome,
  type AuthEventRequest,
  type AuthEventSubject,
} from "../../events";
import { decryptSecret } from "../../secret";
import { extractBearerToken } from "../../utils/bearer";
import { getSamlConfig, getOidcConfig } from "../config";
import { normalizeGroupConnectionPolicy } from "../policy";
import { parseScimPath } from "../scim";
import { isGroupSamlSourceActive } from "../shared";

/**
 * Intentional minimal read-lens — this path only needs `idp.metadataXml`.
 * Not a duplicate of {@link SamlConfigShape}; kept narrow on purpose so the
 * runtime group service doesn't depend on the full SAML config surface.
 */
type RuntimeSamlConfig = {
  idp?: { metadataXml?: string };
};

type RuntimeGroupConnection = {
  _id: string;
  groupId: string;
  protocol: "oidc" | "saml";
  status: "draft" | "active" | "disabled";
  config?: unknown;
};

type RuntimeSamlLoaded = {
  source: { kind: "connection"; id: string };
  config: Record<string, unknown>;
  status: "draft" | "active" | "disabled";
  connection: RuntimeGroupConnection;
};

/** Input for emitting a group-scoped auth event (with optional webhook fan-out). */
export type EmitGroupAuthEventInput<K extends AuthEventKind = AuthEventKind> = {
  connectionId?: string;
  groupId: string;
  kind: K;
  actor: AuthEventActor;
  subject: AuthEventSubject;
  outcome?: AuthEventOutcome;
  request?: AuthEventRequest;
  data?: AuthEventDataByKind[K];
  webhook?: false | { payload?: AuthEventObject };
};

/**
 * Build the runtime group/connection service.
 *
 * Bundles connection and policy loaders, OIDC/SAML config resolution (with
 * secret decryption), policy validation, group-scoped event emission with
 * webhook delivery, and SCIM bearer-token authentication.
 *
 * @returns An object of group-connection service methods.
 */
export function createGroupService(deps: {
  config: ReturnType<typeof configDefaults>;
  sha256: (input: string) => Promise<string>;
}) {
  const { config, sha256 } = deps;
  const connectionNotFoundError = "Connection not found.";

  const getPolicyFromGroup = (group: { policy?: unknown }) =>
    normalizeGroupConnectionPolicy(group.policy);

  const getGroupConnectionSecret = async (
    ctx: ComponentReadCtx | ComponentCtx,
    connectionId: string,
    kind: "oidc_client_secret",
  ) => {
    return await queryGroupConnectionSecret(ctx, config.component.connection, {
      connectionId,
      kind,
    });
  };

  /**
   * Core OIDC config resolver. Fires the connection fetch (when only the ID
   * is known) in parallel with the secret fetch, and decrypts lazily once the
   * secret is available. All three operations are independent until the final
   * merge, so doing them sequentially was costing 30–60ms per OIDC lookup.
   */
  const resolveOidcConfigWithSecret = async (
    ctx: ComponentReadCtx | ComponentCtx,
    connectionId: string,
    preloadedConnection?: { _id: string; config?: unknown },
  ): Promise<Record<string, unknown>> => {
    const [connection, secret] = await Promise.all([
      preloadedConnection !== undefined
        ? Promise.resolve(preloadedConnection)
        : getGroupConnection(ctx, config.component.connection, connectionId),
      getGroupConnectionSecret(ctx, connectionId, "oidc_client_secret"),
    ]);
    if (!connection) {
      throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
    }
    const oidc = getOidcConfig(connection.config);
    if (!secret) {
      return oidc;
    }
    const decrypted = await decryptSecret(secret.ciphertext);
    const existingClient =
      typeof oidc.client === "object" && oidc.client !== null ? oidc.client : {};
    return {
      ...oidc,
      client: { ...existingClient, secret: decrypted },
    };
  };

  const loadGroupPolicyOrThrow = async (ctx: ComponentReadCtx, groupId: string) => {
    const group = await getGroup(ctx, config.component.group, groupId);
    if (!group) {
      throw convexError(ErrorCode.INVALID_PARAMETERS, "Group not found.");
    }
    return getPolicyFromGroup(group);
  };

  const loadConnectionOrThrow = async (
    ctx: ComponentReadCtx,
    connectionId: string,
  ): Promise<RuntimeGroupConnection> => {
    const connection = await getGroupConnection(ctx, config.component.connection, connectionId);
    if (!connection) {
      throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
    }
    return connection;
  };

  const loadActiveGroupConnectionOrThrow = async (ctx: ComponentReadCtx, connectionId: string) => {
    const connection = await loadConnectionOrThrow(ctx, connectionId);
    if (connection.status !== "active") {
      throw convexError(ErrorCode.INVALID_PARAMETERS, "Group connection is not active.");
    }
    return connection;
  };

  const loadActiveConnectionSamlOrThrow = async (ctx: ComponentReadCtx, connectionId: string) => {
    const connection = await loadConnectionOrThrow(ctx, connectionId);
    const loaded = {
      source: {
        kind: "connection" as const,
        id: connectionId,
      },
      config: (connection.config ?? {}) as Record<string, unknown>,
      status: connection.status,
      connection,
    } satisfies RuntimeSamlLoaded;
    if (!isGroupSamlSourceActive(loaded)) {
      throw convexError(ErrorCode.INVALID_PARAMETERS, "Group connection is not active.");
    }
    const saml = getSamlConfig(loaded.config) as RuntimeSamlConfig;
    if (!saml.idp?.metadataXml) {
      throw convexError(
        ErrorCode.PROVIDER_NOT_CONFIGURED,
        "SAML is not configured for this connection.",
      );
    }
    return { loaded, connection, saml };
  };

  const loadConnectionOidcOrThrow = async (ctx: ComponentReadCtx, connectionId: string) => {
    const [connection, oidc] = await Promise.all([
      loadActiveGroupConnectionOrThrow(ctx, connectionId),
      resolveOidcConfigWithSecret(ctx, connectionId),
    ]);
    if (oidc.enabled !== true) {
      throw convexError(
        ErrorCode.PROVIDER_NOT_CONFIGURED,
        "OIDC is not configured for this connection.",
      );
    }
    return { connection, oidc };
  };

  const resolveGroupConnectionConnectionProtocolOrThrow = async (
    ctx: ComponentReadCtx,
    connectionId: string,
  ): Promise<"oidc" | "saml"> => {
    const connection = await loadActiveGroupConnectionOrThrow(ctx, connectionId);
    if (connection.protocol === "oidc") {
      return "oidc";
    }
    if (connection.protocol === "saml") {
      return "saml";
    }
    throw convexError(
      ErrorCode.PROVIDER_NOT_CONFIGURED,
      "Group connection protocol is not configured.",
    );
  };

  const validateGroupConnectionPolicy = (
    policy: ReturnType<typeof normalizeGroupConnectionPolicy>,
  ) => {
    const configuredRoleIds = Object.keys(config.permissions.roles);
    const hasConfiguredRoles = configuredRoleIds.length > 0;
    const checks: Array<{
      name: string;
      ok: boolean;
      message?: string;
    }> = [];

    checks.push({ name: "policy_version", ok: policy.version === 1 });
    if (hasConfiguredRoles) {
      checks.push({
        name: "jit_default_role_ids_known",
        ok: policy.provisioning.jit.defaultRoleIds.every(
          (roleId) => config.permissions.roles[roleId] !== undefined,
        ),
        message: policy.provisioning.jit.defaultRoleIds.every(
          (roleId) => config.permissions.roles[roleId] !== undefined,
        )
          ? undefined
          : "JIT defaultRoleIds contains unknown roleIds.",
      });
      checks.push({
        name: "provisioning_role_mapping_targets_known",
        ok: Object.values(policy.provisioning.roles.mapping ?? {}).every((roleIds) =>
          roleIds.every((roleId) => config.permissions.roles[roleId] !== undefined),
        ),
        message: Object.values(policy.provisioning.roles.mapping ?? {}).every((roleIds) =>
          roleIds.every((roleId) => config.permissions.roles[roleId] !== undefined),
        )
          ? undefined
          : "Provisioning role mappings contain unknown roleIds.",
      });
      checks.push({
        name: "provisioning_group_mapping_targets_known",
        ok: Object.values(policy.provisioning.groups.mapping ?? {}).every((roleIds) =>
          roleIds.every((roleId) => config.permissions.roles[roleId] !== undefined),
        ),
        message: Object.values(policy.provisioning.groups.mapping ?? {}).every((roleIds) =>
          roleIds.every((roleId) => config.permissions.roles[roleId] !== undefined),
        )
          ? undefined
          : "Provisioning group mappings contain unknown roleIds.",
      });
    }
    checks.push({
      name: "scim_reuse_supported",
      ok:
        policy.provisioning.scimReuse.user === "externalId" ||
        policy.provisioning.scimReuse.user === "none",
    });

    return checks;
  };

  const enqueueWebhookDeliveriesForEvent = async (
    ctx: ComponentCtx,
    data: {
      connectionId: string;
      kind: AuthEventKind;
      payload: Record<string, unknown>;
      eventId: string;
    },
  ) => {
    if (data.kind.startsWith("webhook.")) return;
    const endpoints = await listWebhookEndpoints(
      ctx,
      config.component.connection,
      data.connectionId,
    );
    for (const endpoint of endpoints) {
      if (endpoint.status !== "active" || !endpoint.subscriptions.includes(data.kind)) {
        continue;
      }
      if (!endpoint.secretCiphertext) {
        // Compatibility guard for pre-migration hash-only rows. A one-way hash
        // cannot be used as the HMAC secret, so the endpoint stays inert until
        // an operator supplies a new secret.
        console.error("[auth] webhook endpoint has no encrypted secret; skipping", {
          endpointId: endpoint._id,
        });
        continue;
      }
      const signedAt = Date.now();
      let secret: string;
      try {
        secret = await decryptSecret(endpoint.secretCiphertext);
      } catch (err) {
        console.error("[auth] webhook endpoint has unreadable secret; skipping", {
          endpointId: endpoint._id,
          err: err instanceof Error ? err.message : err,
        });
        continue;
      }
      const body = JSON.stringify({ kind: data.kind, payload: data.payload });
      const signature = encodeHexLowerCase(
        hmac(
          SHA256,
          new TextEncoder().encode(secret),
          new TextEncoder().encode(`${signedAt}.${body}`),
        ),
      );
      await ctx.runMutation(config.component.connection.webhook.delivery.create, {
        connectionId: data.connectionId,
        endpointId: endpoint._id,
        eventId: data.eventId,
        kind: data.kind,
        payload: data.payload,
        nextAttemptAt: signedAt,
        signature,
        signedAt,
      });
    }
  };

  const emitGroupAuthEvent = async (ctx: ComponentCtx, data: EmitGroupAuthEventInput) => {
    const result = await emitAuthEvent(ctx, config, {
      kind: data.kind,
      actor: data.actor,
      subject: data.subject,
      targets: [
        { kind: "group", id: data.groupId },
        ...(data.connectionId ? [{ kind: "connection" as const, id: data.connectionId }] : []),
        ...(data.subject.type === "user" && data.subject.id
          ? [{ kind: "user" as const, id: data.subject.id }]
          : []),
      ],
      request: data.request,
      outcome: data.outcome ?? "success",
      data: data.data,
    });
    const eventId = result.eventId as string;
    const connectionEventCreated =
      data.connectionId !== undefined &&
      Array.isArray(result.createdTargets) &&
      result.createdTargets.some(
        (target: { kind: string; id: string }) =>
          target.kind === "connection" && target.id === data.connectionId,
      );
    if (data.connectionId && connectionEventCreated && data.webhook !== false) {
      await enqueueWebhookDeliveriesForEvent(ctx, {
        connectionId: data.connectionId,
        kind: data.kind,
        eventId,
        payload: data.webhook?.payload ?? {
          connectionId: data.connectionId,
          groupId: data.groupId,
          subject: data.subject,
          data: data.data,
        },
      });
    }
    return eventId;
  };

  /**
   * Authenticate a SCIM request and resolve its connection context.
   *
   * Looks up the SCIM config by the path's `connectionId`, then compares the
   * request's bearer token hash against the stored hash in constant time to
   * prevent timing attacks on the token.
   */
  const getGroupConnectionScimContext = async (ctx: ComponentReadCtx, request: Request) => {
    const token = extractBearerToken(request);
    if (token === null) {
      throw convexError(
        ErrorCode.MISSING_BEARER_TOKEN,
        "Missing or malformed Authorization: Bearer header.",
      );
    }
    const parsedPath = parseScimPath(new URL(request.url).pathname);

    const scimConfig = await getScimConfigByConnection(
      ctx,
      config.component.connection,
      parsedPath.connectionId,
    );
    const tokenHash = await sha256(token);
    if (
      !scimConfig ||
      scimConfig.status !== "active" ||
      !scimConfig.tokenHash ||
      !constantTimeEqualHex(tokenHash, scimConfig.tokenHash)
    ) {
      throw convexError(ErrorCode.INVALID_API_KEY, "Invalid SCIM token.");
    }

    const connection = await getGroupConnection(
      ctx,
      config.component.connection,
      scimConfig.connectionId,
    );
    if (connection === null) {
      throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
    }
    if (connection.status !== "active") {
      throw convexError(ErrorCode.INVALID_PARAMETERS, "Connection is not active.");
    }
    return {
      scimConfig,
      connection,
      parsedPath,
    };
  };

  return {
    getGroupConnectionSecret,
    loadGroupPolicyOrThrow,
    loadConnectionOrThrow,
    loadActiveGroupConnectionOrThrow,
    loadActiveConnectionSamlOrThrow,
    loadConnectionOidcOrThrow,
    resolveGroupConnectionConnectionProtocolOrThrow,
    validateGroupConnectionPolicy,
    emitGroupAuthEvent,
    getGroupConnectionScimContext,
  };
}
