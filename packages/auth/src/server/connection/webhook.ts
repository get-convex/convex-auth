import type { EncryptedSecret } from "../../shared/brand";
import { ErrorCode } from "../../shared/codes";
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
 * Webhook endpoint doc with the encrypted `secretCiphertext` stripped, for the
 * public/admin read facade (`endpoint.get`/`endpoint.list`). The raw ciphertext
 * stays internal to delivery signing, which reads the doc directly via
 * `getWebhookEndpoint`. Exposes a `hasSecret` flag instead.
 */
function getPublicWebhookEndpoint<T extends { secretCiphertext?: unknown }>(
  endpoint: T | null | undefined,
): (Omit<T, "secretCiphertext"> & { hasSecret: boolean }) | null {
  if (!endpoint) {
    return null;
  }
  const { secretCiphertext, ...rest } = endpoint;
  return { ...rest, hasSecret: secretCiphertext !== undefined && secretCiphertext !== null };
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
