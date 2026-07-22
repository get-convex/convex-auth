import type { EncryptedSecret } from "../../shared/brand";
import { ErrorCode } from "../../shared/codes";
import { EVENT_KINDS } from "../../shared/event/kinds";
import { unsafeFetchUrlReason } from "../../shared/fetch/guard";
import type { ComponentCtx, ComponentReadCtx } from "../component/context";
import {
  createWebhookEndpoint,
  getWebhookEndpoint,
  listReadyWebhookDeliveries,
  listWebhookDeliveries,
  listWebhookEndpoints,
  updateWebhookEndpoint,
  updateWebhookDelivery,
} from "../contract";
import { convexError } from "../errors";
import type { AuthEventKind } from "../events";
import type { EmitGroupAuthEventInput } from "./group/service";
import type { ConvexAuthMaterializedConfig } from "../types";

/**
 * Validate an operator-supplied webhook target URL before it is persisted and
 * later `fetch`ed server-side, rejecting requests that could be turned into SSRF
 * probes of internal infrastructure. Webhook targets are customer endpoints that
 * must always be publicly reachable, so — unlike the IdP discovery/metadata
 * fetch guard — this is not subject to the self-hosted private-host opt-out.
 *
 * See {@link unsafeFetchUrlReason} for the scheme/hostname rules. This is
 * scheme/hostname-level validation only — it does not defend against DNS
 * rebinding, where a public hostname resolves to a private address at delivery
 * time.
 *
 * @internal
 */
export function assertSafeWebhookUrl(url: string): void {
  const reason = unsafeFetchUrlReason(url);
  if (reason !== null) {
    throw convexError(ErrorCode.INVALID_PARAMETERS, `Webhook ${reason}`);
  }
}

type WebhookDeps = {
  config: ConvexAuthMaterializedConfig;
  encryptSecret: (value: string) => Promise<EncryptedSecret>;
  loadConnectionOrThrow: (
    ctx: ComponentReadCtx,
    connectionId: string,
  ) => Promise<{
    _id: string;
    groupId: string;
    protocol: "oidc" | "saml";
    status: "draft" | "active" | "disabled";
    config?: unknown;
  }>;
  emitGroupAuthEvent: (ctx: ComponentCtx, data: EmitGroupAuthEventInput) => Promise<string>;
};

/**
 * Webhook endpoint doc with all stored credential material stripped for the
 * public/admin read facade (`endpoint.get`/`endpoint.list`). The raw ciphertext
 * stays internal to delivery signing, which reads the component doc directly.
 * Hash-only legacy rows are reported as disabled until a new secret is stored.
 *
 * @internal
 */
export function getPublicWebhookEndpoint<
  T extends {
    secretCiphertext?: unknown;
    secretHash?: unknown;
    status: "active" | "disabled";
    subscriptions: string[];
  },
>(
  endpoint: T | null | undefined,
):
  | (Omit<T, "secretCiphertext" | "secretHash" | "status" | "subscriptions"> & {
      status: "active" | "disabled";
      subscriptions: AuthEventKind[];
      hasSecret: boolean;
    })
  | null {
  if (!endpoint) {
    return null;
  }
  const { secretCiphertext, secretHash: _secretHash, status, subscriptions, ...rest } = endpoint;
  const hasSecret = typeof secretCiphertext === "string" && secretCiphertext.length > 0;
  return {
    ...rest,
    status: hasSecret ? status : "disabled",
    subscriptions: subscriptions.filter((kind): kind is AuthEventKind =>
      Object.prototype.hasOwnProperty.call(EVENT_KINDS, kind),
    ),
    hasSecret,
  };
}

export function createGroupWebhookDomain(deps: WebhookDeps) {
  const { config, encryptSecret, loadConnectionOrThrow, emitGroupAuthEvent } = deps;

  return {
    endpoint: {
      get: async (ctx: ComponentReadCtx, args: { id: string }) => {
        return getPublicWebhookEndpoint(
          await getWebhookEndpoint(ctx, config.component.connection, args.id),
        );
      },
      create: async (
        ctx: ComponentCtx,
        data: {
          connectionId: string;
          url: string;
          secret: string;
          subscriptions: AuthEventKind[];
          createdByUserId?: string;
        },
      ) => {
        assertSafeWebhookUrl(data.url);
        if (data.secret.length === 0) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, "Webhook secret must not be empty.");
        }
        const connection = await loadConnectionOrThrow(ctx, data.connectionId);
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, "Connection not found.");
        }
        const secretCiphertext = await encryptSecret(data.secret);
        const endpointId = await createWebhookEndpoint(ctx, config.component.connection, {
          connectionId: connection._id,
          groupId: connection.groupId,
          url: data.url,
          secretCiphertext,
          subscriptions: data.subscriptions,
          createdByUserId: data.createdByUserId,
        });
        await emitGroupAuthEvent(ctx, {
          connectionId: connection._id,
          groupId: connection.groupId,
          kind: "webhook.endpoint.created",
          actor: data.createdByUserId
            ? { type: "user", id: data.createdByUserId }
            : { type: "system" },
          subject: { type: "webhook_endpoint", id: endpointId },
          webhook: false,
        });
        return { endpointId };
      },
      list: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const endpoints = await listWebhookEndpoints(
          ctx,
          config.component.connection,
          args.connectionId,
        );
        return endpoints.map((endpoint) => getPublicWebhookEndpoint(endpoint)!);
      },
      /**
       * Update webhook delivery settings and optionally rotate its signing
       * secret. A hash-only legacy endpoint must supply a new secret before it
       * can be reactivated.
       */
      update: async (
        ctx: ComponentCtx,
        args: {
          id: string;
          patch: {
            url?: string;
            status?: "active" | "disabled";
            secret?: string;
            subscriptions?: AuthEventKind[];
          };
        },
      ) => {
        const endpoint = await getWebhookEndpoint(ctx, config.component.connection, args.id);
        if (!endpoint) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, "Webhook endpoint not found.");
        }
        if (args.patch.url !== undefined) {
          assertSafeWebhookUrl(args.patch.url);
        }
        if (args.patch.secret !== undefined && args.patch.secret.length === 0) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, "Webhook secret must not be empty.");
        }
        if (
          args.patch.status === "active" &&
          args.patch.secret === undefined &&
          !endpoint.secretCiphertext
        ) {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "A new webhook secret is required before this endpoint can be enabled.",
          );
        }
        const secretCiphertext =
          args.patch.secret === undefined ? undefined : await encryptSecret(args.patch.secret);
        await updateWebhookEndpoint(ctx, config.component.connection, {
          endpointId: args.id,
          patch: {
            ...(args.patch.url === undefined ? {} : { url: args.patch.url }),
            ...(args.patch.status === undefined ? {} : { status: args.patch.status }),
            ...(args.patch.subscriptions === undefined
              ? {}
              : { subscriptions: args.patch.subscriptions }),
            ...(secretCiphertext === undefined ? {} : { secretCiphertext }),
          },
        });
        return { endpointId: args.id };
      },
      revoke: async (ctx: ComponentCtx, args: { id: string }) => {
        const endpoint = await getWebhookEndpoint(ctx, config.component.connection, args.id);
        await updateWebhookEndpoint(ctx, config.component.connection, {
          endpointId: args.id,
          patch: { status: "disabled" },
        });
        if (endpoint) {
          await emitGroupAuthEvent(ctx, {
            connectionId: endpoint.connectionId,
            groupId: endpoint.groupId,
            kind: "webhook.endpoint.disabled",
            actor: { type: "system" },
            subject: { type: "webhook_endpoint", id: args.id },
            webhook: false,
          });
        }
        return { endpointId: args.id };
      },
    },
    delivery: {
      list: async (
        ctx: ComponentReadCtx,
        data: {
          connectionId: string;
          paginationOpts: { numItems: number; cursor: string | null };
        },
      ) => {
        return await listWebhookDeliveries(ctx, config.component.connection, data);
      },
      listReady: async (ctx: ComponentReadCtx, args: { limit?: number } = {}) => {
        return await listReadyWebhookDeliveries(ctx, config.component.connection, {
          now: Date.now(),
          limit: args.limit,
        });
      },
      markDelivered: async (ctx: ComponentCtx, args: { id: string; responseStatus?: number }) => {
        await updateWebhookDelivery(ctx, config.component.connection, {
          deliveryId: args.id,
          patch: {
            status: "delivered",
            attemptCount: 1,
            lastAttemptAt: Date.now(),
            lastResponseStatus: args.responseStatus,
          },
        });
      },
      markFailed: async (
        ctx: ComponentCtx,
        args: {
          id: string;
          data: {
            attemptCount: number;
            responseStatus?: number;
            error?: string;
            retryAt?: number;
          };
        },
      ) => {
        await updateWebhookDelivery(ctx, config.component.connection, {
          deliveryId: args.id,
          patch: {
            status: args.data.retryAt ? "pending" : "failed",
            attemptCount: args.data.attemptCount,
            lastAttemptAt: Date.now(),
            lastResponseStatus: args.data.responseStatus,
            lastError: args.data.error,
            nextAttemptAt: args.data.retryAt ?? Date.now(),
          },
        });
      },
    },
  };
}
