/**
 * OAuth sign-in and callback HTTP handler closures.
 *
 * Extracted from the composition root: {@link createOAuthHttpHandlers} builds
 * the `GET /signin/*` and `GET`/`POST /callback/*` handlers registered by
 * `addAuthRoutes`. The handlers drive the provider authorization URL, persist
 * the verifier signature, exchange the callback for a profile, and redirect the
 * browser back with the issued verification code.
 *
 * @internal
 * @module
 */

import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, type Value } from "convex/values";
import { serialize as serializeCookie } from "cookie";

import { ErrorCode } from "../../shared/codes";
import type { configDefaults } from "../config";
import { decodeOAuthState, encodeOAuthState } from "../cookies";
import { convertErrorsToResponse, getCookies } from "../http";
import { LOG_LEVELS, log, logError } from "../log";
import { callUserOAuth, callVerifierSignature } from "../mutations/calls";
import type { AuthProfile } from "../payloads";
import { redirectAbsoluteUrl, setURLSearchParam } from "../redirects";
import type { OAuthMaterializedConfig } from "../types";
import { createOAuthAuthorizationURL, handleOAuthCallback } from "./runtime";

const convexError = (data: Record<string, Value>) => new ConvexError(data);

function formDataEntries(formData: unknown): Iterable<[string, string | { name: string }]> {
  return formData as Iterable<[string, string | { name: string }]>;
}

/** Dependencies injected by the runtime into the OAuth sign-in/callback handlers. */
export interface OAuthHttpHandlerDeps {
  config: ReturnType<typeof configDefaults>;
  getProviderOrThrow: (id: string, allowExtraProviders?: boolean) => { type: string };
  authCallbackUrl: (providerId: string) => string;
}

/**
 * Build the OAuth `handleSignIn` and `handleCallback` closures for
 * `addAuthRoutes`. `handleSignIn` starts the provider authorization redirect and
 * stores the verifier signature; `handleCallback` completes the exchange and
 * redirects back to the app with the verification `code` (falling back to the
 * default destination on error).
 */
export function createOAuthHttpHandlers(deps: OAuthHttpHandlerDeps) {
  const { config, getProviderOrThrow, authCallbackUrl } = deps;
  return {
    handleSignIn: convertErrorsToResponse(400, async (ctx, request) => {
      const url = new URL(request.url);
      const pathParts = url.pathname.split("/");
      const providerId = pathParts[pathParts.length - 1]!;
      if (providerId === null) {
        throw convexError({
          code: ErrorCode.OAUTH_MISSING_PROVIDER,
          message: "Missing OAuth provider ID.",
        });
      }
      const verifier = url.searchParams.get("code");
      if (verifier === null) {
        throw convexError({
          code: ErrorCode.OAUTH_MISSING_VERIFIER,
          message: "Missing sign-in verifier.",
        });
      }
      const provider = getProviderOrThrow(providerId);

      const oauthConfig = provider as OAuthMaterializedConfig;
      const redirectTo = url.searchParams.get("redirectTo");
      const { redirect, cookies, signature } = await createOAuthAuthorizationURL(
        providerId,
        oauthConfig,
        {
          redirectUri: authCallbackUrl(providerId),
          stateTransform: (state) => encodeOAuthState(state, redirectTo),
        },
      );

      await callVerifierSignature(ctx, {
        verifier,
        signature,
      });

      const headers = new Headers({ Location: redirect });
      for (const { name, value, options } of cookies) {
        headers.append("Set-Cookie", serializeCookie(name, value, options));
      }

      return new Response(null, { status: 302, headers });
    }),
    handleCallback: async (ctx: GenericActionCtx<GenericDataModel>, request: Request) => {
      const url = new URL(request.url);
      const callbackPathParts = new URL(request.url).pathname.split("/");
      const providerId = callbackPathParts[callbackPathParts.length - 1];
      if (!providerId) {
        throw convexError({
          code: ErrorCode.OAUTH_MISSING_PROVIDER,
          message: "Missing OAuth provider ID.",
        });
      }
      log(LOG_LEVELS.DEBUG, "Handling OAuth callback for provider:", providerId);
      const provider = getProviderOrThrow(providerId);

      const cookies = getCookies(request);

      const params = url.searchParams;

      if (request.headers.get("Content-Type")?.includes("application/x-www-form-urlencoded")) {
        const formData = await request.formData();
        for (const [key, value] of formDataEntries(formData)) {
          if (typeof value === "string") {
            params.append(key, value);
          }
        }
      }

      const fallbackDestinationUrl = await redirectAbsoluteUrl(ctx, config, {
        redirectTo: undefined,
      });

      try {
        const oauthConfig = provider as OAuthMaterializedConfig;
        const result = await handleOAuthCallback(
          providerId,
          oauthConfig,
          Object.fromEntries(params.entries()),
          cookies,
          { redirectUri: authCallbackUrl(providerId) },
        );
        const oauthCookies = result.cookies;
        const { id: profileId, emails: profileEmails, ...profileData } = result.profile;
        const { signature } = result;
        const { redirectTo: stateRedirectTo } = decodeOAuthState(params.get("state") ?? "");
        const destinationUrl = await redirectAbsoluteUrl(ctx, config, {
          redirectTo: stateRedirectTo ?? undefined,
        });

        const verificationCode = await callUserOAuth(ctx, {
          provider: providerId,
          providerAccountId: profileId,
          profile: profileData as AuthProfile,
          emails: profileEmails,
          signature,
        });

        const redirUrl = setURLSearchParam(destinationUrl, "code", verificationCode);
        const redirHeaders = new Headers({ Location: redirUrl });
        redirHeaders.set("Cache-Control", "must-revalidate");
        for (const { name, value, options } of oauthCookies as Array<{
          name: string;
          value: string;
          options: Parameters<typeof serializeCookie>[2];
        }>) {
          redirHeaders.append("Set-Cookie", serializeCookie(name, value, options));
        }
        return new Response(null, {
          status: 302,
          headers: redirHeaders,
        });
      } catch (error) {
        logError(error);
        return new Response(null, {
          status: 302,
          headers: { Location: fallbackDestinationUrl },
        });
      }
    },
  };
}
