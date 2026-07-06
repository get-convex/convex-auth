import type { PaginationResult } from "convex/server";
import type { Infer } from "convex/values";

import { constantTimeEqualHex } from "../../shared/compare";
import { cached, invalidateCtxCache } from "../cache/context";
import type { AuthComponentApi } from "../component/api";
import type { ComponentCtx, ComponentReadCtx } from "../component/context";
import { vOAuthClientDoc } from "../../component/model";
import type { configDefaults } from "../config";
import { emitAuthEvent } from "../events";
import { generateApiKey, hashApiKey } from "../keys";
import { generateRandomString } from "../random";

const CLIENT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CLIENT_ID_LENGTH = 24;

/**
 * An OAuth client document crossing the component boundary — the single source
 * of truth is `vOAuthClientDoc`. `clientSecretHash` is present iff the client is
 * confidential (server-side only).
 */
export type OAuthClientDoc = Infer<typeof vOAuthClientDoc>;

/** Token-endpoint auth method stored on a client; `none` marks a public client. */
export type OAuthTokenEndpointAuthMethod = NonNullable<OAuthClientDoc["tokenEndpointAuthMethod"]>;

/** Fields accepted when registering a client (the `data` payload). */
type OAuthClientData = {
  name: string;
  redirectUris: string[];
  scopes: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
  createdBy?: string;
  extend?: Record<string, unknown>;
};

/** Mutable client metadata replaced by an RFC 7592 `PUT` (none of it secret). */
export type OAuthClientUpdate = {
  name?: string;
  redirectUris?: string[];
  scopes?: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
};

/** Dependencies injected into the OAuth client domain. */
export type OAuthClientDeps = {
  component: AuthComponentApi;
  events?: ReturnType<typeof configDefaults>["events"];
};

/** Public API surface for the OAuth client sub-domain. */
export interface OAuthClientDomain {
  /** Register a new OAuth client. Returns the public `clientId`, the one-time
   *  `clientSecret` (`cs_*`, omitted for public `none` clients), and the
   *  one-time RFC 7592 `registrationAccessToken` (`reg_*`) used to manage it.
   *  Store the secrets securely — they cannot be retrieved later. */
  create(
    ctx: ComponentCtx,
    args: { data: OAuthClientData },
  ): Promise<{
    clientId: string;
    clientSecret?: string;
    registrationAccessToken: string;
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  }>;

  /** Fetch a client by its public `clientId`. Returns `null` if not found. */
  get(ctx: ComponentReadCtx, args: { clientId: string }): Promise<OAuthClientDoc | null>;

  /** Replace a client's mutable registration metadata (RFC 7592 `PUT`). The
   *  caller is responsible for validating the patch (redirect-uri rules, scope
   *  clamping) before calling. */
  update(ctx: ComponentCtx, args: { clientId: string; patch: OAuthClientUpdate }): Promise<void>;

  /** Verify an RFC 7592 registration access token against the client named by
   *  `clientId`. Returns the client doc on a constant-time hash match, else
   *  `null` (unknown/revoked client, or no/again-mismatched token). */
  verifyRegistrationToken(
    ctx: ComponentReadCtx,
    args: { clientId: string; token: string },
  ): Promise<OAuthClientDoc | null>;

  /** List clients, optionally filtered by creator. Excludes revoked by default. */
  list(
    ctx: ComponentReadCtx,
    args?: {
      where?: { createdBy?: string; includeRevoked?: boolean };
      paginationOpts?: { numItems: number; cursor: string | null };
    },
  ): Promise<PaginationResult<OAuthClientDoc>>;

  /** Soft-revoke a client. Revoked clients can no longer obtain tokens. */
  revoke(ctx: ComponentCtx, args: { clientId: string }): Promise<{ clientId: string }>;

  /** Verify a client secret against the stored hash. Returns the client doc
   *  on success, `null` on mismatch or if the client is revoked. */
  verify(
    ctx: ComponentReadCtx,
    args: { clientId: string; clientSecret: string },
  ): Promise<OAuthClientDoc | null>;
}

/** @internal */
export function createOAuthClientDomain(deps: OAuthClientDeps): OAuthClientDomain {
  const component = deps.component;
  return {
    async create(ctx, { data }) {
      const clientId = "oc_" + generateRandomString(CLIENT_ID_LENGTH, CLIENT_ID_ALPHABET);
      const tokenEndpointAuthMethod = data.tokenEndpointAuthMethod ?? "client_secret_post";
      const secret = tokenEndpointAuthMethod === "none" ? null : await generateApiKey("cs_");
      const { raw: registrationAccessToken, hashedKey: registrationAccessTokenHash } =
        await generateApiKey("reg_");
      await ctx.runMutation(component.oauth.client.create, {
        clientId,
        clientSecretHash: secret?.hashedKey,
        tokenEndpointAuthMethod,
        registrationAccessTokenHash,
        name: data.name,
        redirectUris: data.redirectUris,
        scopes: data.scopes,
        grantTypes: data.grantTypes ?? ["authorization_code", "refresh_token"],
        createdBy: data.createdBy,
        extend: data.extend,
      });
      await emitAuthEvent(ctx, deps, {
        kind: "oauth.client.created",
        actor: data.createdBy ? { type: "user", id: data.createdBy } : { type: "system" },
        subject: { type: "oauth_client", id: clientId },
        targets: [
          { kind: "oauth_client", id: clientId },
          ...(data.createdBy ? [{ kind: "user" as const, id: data.createdBy }] : []),
        ],
        outcome: "success",
        data: { clientId, name: data.name, scopes: data.scopes },
      });
      return {
        clientId,
        clientSecret: secret?.raw,
        registrationAccessToken,
        tokenEndpointAuthMethod,
      };
    },

    async get(ctx, { clientId }) {
      return (await cached(ctx, `oauth-client:${clientId}`, () =>
        ctx.runQuery(component.oauth.client.get, { clientId }),
      )) as OAuthClientDoc | null;
    },

    async list(ctx, args) {
      return (await ctx.runQuery(component.oauth.client.list, {
        where: args?.where,
        paginationOpts: args?.paginationOpts ?? { numItems: 50, cursor: null },
      })) as PaginationResult<OAuthClientDoc>;
    },

    async revoke(ctx, { clientId }) {
      await ctx.runMutation(component.oauth.client.revoke, { clientId });
      invalidateCtxCache(ctx, `oauth-client:${clientId}`);
      await emitAuthEvent(ctx, deps, {
        kind: "oauth.client.revoked",
        actor: { type: "system" },
        subject: { type: "oauth_client", id: clientId },
        targets: [{ kind: "oauth_client", id: clientId }],
        outcome: "success",
        data: { clientId },
      });
      return { clientId };
    },

    async update(ctx, { clientId, patch }) {
      await ctx.runMutation(component.oauth.client.update, { clientId, patch });
      invalidateCtxCache(ctx, `oauth-client:${clientId}`);
    },

    async verify(ctx, { clientId, clientSecret }) {
      const doc = (await cached(ctx, `oauth-client:${clientId}`, () =>
        ctx.runQuery(component.oauth.client.get, { clientId }),
      )) as OAuthClientDoc | null;
      if (!doc || doc.revoked || doc.tokenEndpointAuthMethod === "none" || !doc.clientSecretHash) {
        return null;
      }
      const hash = await hashApiKey(clientSecret);
      return constantTimeEqualHex(hash, doc.clientSecretHash) ? doc : null;
    },

    async verifyRegistrationToken(ctx, { clientId, token }) {
      const doc = (await cached(ctx, `oauth-client:${clientId}`, () =>
        ctx.runQuery(component.oauth.client.get, { clientId }),
      )) as OAuthClientDoc | null;
      if (!doc || doc.revoked || !doc.registrationAccessTokenHash) return null;
      const hash = await hashApiKey(token);
      return constantTimeEqualHex(hash, doc.registrationAccessTokenHash) ? doc : null;
    },
  };
}
