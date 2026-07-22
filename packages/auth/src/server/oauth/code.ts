import { ConvexError, type Infer } from "convex/values";

import { vOAuthCodeDoc } from "../../component/model";
import { ErrorCode } from "../../shared/codes";
import { cached } from "../cache/context";
import type { AuthComponentApi } from "../component/api";
import type { ComponentCtx } from "../component/context";
import type { configDefaults } from "../config";
import { emitAuthEvent } from "../events";
import { generateRandomString, sha256 } from "../random";
import type { OAuthClientDoc } from "./client";
import { checkOAuthGrant, type OAuthGrantDenial } from "./grant";

const CODE_LENGTH = 32;
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_TTL_MS = 2 * 60 * 1000;

/**
 * Stored authorization-code grant consumed at the token endpoint — derived from
 * `vOAuthCodeDoc` (the single source of truth) so it never drifts from storage.
 */
export type OAuthCodeRecord = Infer<typeof vOAuthCodeDoc>;

/** Map a grant denial to a `ConvexError` for the post-consent (mutation) boundary. */
const GRANT_ERROR: Record<OAuthGrantDenial["reason"], { code: string; message: string }> = {
  client_not_found: {
    code: ErrorCode.OAUTH_CLIENT_NOT_FOUND,
    message: "Unknown or inactive OAuth client.",
  },
  redirect_uri_mismatch: {
    code: ErrorCode.OAUTH_REDIRECT_URI_MISMATCH,
    message: "redirect_uri not registered for this client.",
  },
  grant_type_not_allowed: {
    code: ErrorCode.OAUTH_GRANT_TYPE_NOT_ALLOWED,
    message: "authorization_code grant is not allowed for this client.",
  },
  scope_not_allowed: {
    code: ErrorCode.OAUTH_SCOPE_NOT_ALLOWED,
    message: "Scope not permitted for this client.",
  },
};

function oauthGrantConvexError(
  denial: OAuthGrantDenial,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError(GRANT_ERROR[denial.reason]);
}

/**
 * Harden the library boundary for {@link OAuthCodeDomain.authorize}: the minted
 * authorization code is bound to `userId`, so that id MUST be the authenticated
 * caller — never a value taken from request input, or a client could mint codes
 * for arbitrary users. Resolve the caller from `ctx.auth.getUserIdentity()` and
 * reject unless its subject matches the passed `userId`.
 *
 * `ComponentCtx` is typed only for `runQuery`/`runMutation`, but the documented
 * caller is an authenticated app mutation whose ctx carries `auth`; so the
 * identity is read defensively. A ctx that exposes no identity capability, an
 * unauthenticated caller, or a subject mismatch all fail closed.
 */
async function assertAuthorizeCallerMatchesUser(ctx: ComponentCtx, userId: string): Promise<void> {
  const auth = (
    ctx as {
      auth?: { getUserIdentity?: () => Promise<{ subject?: string | null } | null> };
    }
  ).auth;
  const identity =
    typeof auth?.getUserIdentity === "function" ? await auth.getUserIdentity() : undefined;
  if (!identity || identity.subject !== userId) {
    throw new ConvexError({
      code: ErrorCode.NOT_AUTHORIZED,
      message:
        "oauth.authorize must be called by the authenticated user it authorizes; " +
        "resolve `userId` from ctx.auth.getUserIdentity() rather than request input.",
    });
  }
}

/** Public API surface for the OAuth authorization-code sub-domain. */
export interface OAuthCodeDomain {
  /**
   * Record a user's approval of a client's access request and mint a single-use
   * authorization code (plain returned, hash stored). Validates the client grant
   * via the shared {@link checkOAuthGrant} predicate, inserts an `OAuthCode` with
   * the PKCE challenge and TTL, and emits `oauth.code.created`.
   *
   * Call this from an app mutation after confirming the user's intent on the
   * consent page. `userId` MUST be the authenticated caller resolved via
   * `ctx.auth.getUserIdentity()` — never a value from request input, or a client
   * could mint codes for arbitrary users.
   */
  authorize(
    ctx: ComponentCtx,
    args: {
      userId: string;
      clientId: string;
      scopes: string[];
      redirectUri: string;
      codeChallenge: string;
      resource?: string;
      state?: string | null;
    },
  ): Promise<{ code: string; redirectUri: string; state?: string | null }>;

  /**
   * Accept (consume) a single-use authorization code by its hash, enforcing the
   * `clientId`, `redirectUri`, and PKCE `codeChallenge` bindings in-transaction.
   * Returns the grant, or `null` if the hash is unknown or any binding fails (the
   * code is NOT burned). Throws `OAUTH_CODE_ALREADY_USED` on replay /
   * `OAUTH_CODE_EXPIRED` if stale.
   */
  accept(
    ctx: ComponentCtx,
    args: { codeHash: string; clientId: string; redirectUri: string; codeChallenge: string },
  ): Promise<OAuthCodeRecord | null>;
}

/** @internal */
export function createOAuthCodeDomain(deps: {
  component: AuthComponentApi;
  events?: ReturnType<typeof configDefaults>["events"];
}): OAuthCodeDomain {
  const component = deps.component;
  return {
    async authorize(ctx, args) {
      // Never trust the caller-supplied `userId`: it must equal the
      // authenticated identity, or a client could mint codes for other users.
      await assertAuthorizeCallerMatchesUser(ctx, args.userId);

      const client = (await cached(ctx, `oauth-client:${args.clientId}`, () =>
        ctx.runQuery(component.oauth.client.get, { clientId: args.clientId }),
      )) as OAuthClientDoc | null;

      const check = checkOAuthGrant({
        client,
        grantType: "authorization_code",
        redirectUri: args.redirectUri,
        requestedScopes: args.scopes,
      });
      if (!check.ok) throw oauthGrantConvexError(check.denial);

      const rawCode = generateRandomString(CODE_LENGTH, CODE_ALPHABET);
      const codeHash = await sha256(rawCode);
      await ctx.runMutation(component.oauth.code.create, {
        codeHash,
        userId: args.userId,
        clientId: args.clientId,
        redirectUri: args.redirectUri,
        scopes: args.scopes,
        codeChallenge: args.codeChallenge,
        resource: args.resource,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      await emitAuthEvent(ctx, deps, {
        kind: "oauth.code.created",
        actor: { type: "user", id: args.userId },
        subject: { type: "oauth_code", id: codeHash },
        targets: [
          { kind: "oauth_client", id: args.clientId },
          { kind: "user", id: args.userId },
        ],
        outcome: "success",
        data: {
          clientId: args.clientId,
          codeId: codeHash,
          scopes: args.scopes,
          redirectUri: args.redirectUri,
        },
      });
      return { code: rawCode, redirectUri: args.redirectUri, state: args.state };
    },

    async accept(ctx, { codeHash, clientId, redirectUri, codeChallenge }) {
      return (await ctx.runMutation(component.oauth.code.accept, {
        codeHash,
        clientId,
        redirectUri,
        codeChallenge,
      })) as OAuthCodeRecord | null;
    },
  };
}
