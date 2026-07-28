import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import {
  vTokenBundle,
  type ProviderHelpers,
  type TokenBundle,
} from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import {
  decryptTicketPayload,
  generateRandomToken,
  sha256Base64Url,
} from "./crypto";
import { sha256Hex } from "../../lib/crypto";

/**
 * Standard OIDC id_token claims. The well-known ones are typed; any other
 * claim the provider includes is present but untyped (`unknown`).
 */
export type OidcClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  [claim: string]: unknown;
};

/**
 * Map what the provider told us about the user — id_token claims
 * (`undefined` for non-OIDC providers) and userinfo responses keyed as
 * configured (`undefined` unless the catalog sets `userInfoEndpoints`) — to the
 * account identity used at redemption. `id` becomes the provider account id.
 * Supplied by each provider's catalog (see `google.ts`, `github.ts`).
 *
 * `UserInfo` is the catalog's declared shape for the userinfo responses,
 * keyed like `userInfoEndpoints`. It types what the provider is trusted to
 * return — the responses are provider-attested JSON and are not validated
 * against it at runtime.
 */
export type OauthProfile<
  // `any` default so unparameterized mappings can dig into responses
  // without casting.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UserInfo extends Record<string, unknown> = Record<string, any>,
> = (
  claims: OidcClaims | undefined,
  userInfoResponses: UserInfo | undefined,
) => { id: string; [key: string]: unknown };

/**
 * Provider-defined config for interacting with an individual OAuth provider.
 *
 * `UserInfo` declares the shape of the userinfo responses, tying
 * `userInfoEndpoints` keys to what `profile` receives (see
 * {@link OauthProfile}).
 */
export type OauthCatalog<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UserInfo extends Record<string, unknown> = Record<string, any>,
> = {
  /**
   * The provider's authorization endpoint (a full URL), e.g. Google's
   * `https://accounts.google.com/o/oauth2/v2/auth`.
   */
  authorizationEndpoint: string;
  /**
   * The provider's token endpoint (a full URL), e.g. Google's
   * `https://oauth2.googleapis.com/token`.
   */
  tokenEndpoint: string;
  /**
   * Expected `iss` (the OIDC issuer claim) of the provider's id_tokens, e.g.
   * Google's `https://accounts.google.com`. Present for OIDC providers;
   * absent for plain-OAuth providers (e.g., GitHub), where identity comes from
   * userinfo.
   */
  issuer?: string;
  /**
   * Endpoints (full URLs) the callback fetches with the access token (GET
   * with a bearer token), keyed by the name the `profile` mapping reads
   * each response under. Present for providers whose identity comes from
   * userinfo (GitHub). The keys must match `UserInfo`'s.
   */
  userInfoEndpoints?: { [K in keyof UserInfo & string]: string };
  /** Default scopes to request; overridable via {@link OauthProviderOptions.scopes}. */
  scopes: string[];
  /**
   * Send a PKCE `S256` challenge with the authorization request. Enable it for
   * providers that support PKCE alongside the client secret.
   */
  pkce: boolean;
  /** Map the provider's attested identity to the account profile. */
  profile: OauthProfile<UserInfo>;
};

/**
 * App-defined config for setting up an OAuth provider and passing in options.
 */
export type OauthProviderOptions = {
  /**
   * This provider's oauth component mount, e.g. `components.oauthGoogle`.
   * The component is mounted once per provider.
   */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
  /**
   * Override the provider's default scopes (e.g. to request extra scopes).
   */
  scopes?: string[];
  /**
   * Extra query params for the authorization URL, e.g. Google's
   * `{ access_type: "offline" }`. Must not include protocol params (listed below).
   */
  extraAuthorizationParams?: Record<string, string>;
};

/** `new URL` without the exception: returns null on unparseable input. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Params `startSignIn` sets itself, these are not allowed in `extraAuthorizationParams`. */
const PROTOCOL_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
];

/**
 * Set up OAuth sign-in against a single upstream identity provider.
 *
 * The flow:
 *
 * 1. `startSignIn` (here): validate, mint `state`, record an authorization
 *    request in the component, and return the provider authorization URL for
 *    the client to navigate to plus the state it must hold onto.
 * 2. The provider redirects back to the mount's HTTP callback
 *    (`<site><httpPrefix>/callback`), which claims the request, exchanges
 *    the code, and mints a one-time ticket.
 * 3. `completeSignIn` (here): the client presents the one-time code from the
 *    callback redirect plus its original state, and gets back the session
 *    token bundle.
 *
 * The callback only accepts GET redirects. Providers that POST it
 * (`response_mode=form_post`, notably Apple when name/email scopes are
 * requested) are not supported yet.
 * TODO: support response_mode=form_post (Apple) before launch.
 */
export function setupOauth<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UserInfo extends Record<string, unknown> = Record<string, any>,
>(
  providerName: string,
  catalog: OauthCatalog<UserInfo>,
  helpers: ProviderHelpers,
  options: OauthProviderOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time, not on the first sign-in.
  const allowedOrigins = options.allowedRedirectOrigins.map((allowed) => {
    const url = parseUrl(allowed);
    if (
      url === null ||
      (url.protocol !== "http:" && url.protocol !== "https:")
    ) {
      throw new Error(
        `allowedRedirectOrigins entry is not a valid http(s) origin: ` +
          `"${allowed}" (custom schemes like "myapp://" are not supported yet)`,
      );
    }
    return url.origin;
  });
  const scopes = options.scopes ?? catalog.scopes;
  // Per OIDC, requesting the `openid` scope makes the provider return an
  // id_token, which must be validated against an expected issuer.
  if (scopes.includes("openid") && catalog.issuer === undefined) {
    throw new Error(
      `Provider "${providerName}" requests the "openid" scope, so the provider will return an id_token, but its catalog sets no issuer to validate it against`,
    );
  }
  for (const key of Object.keys(options.extraAuthorizationParams ?? {})) {
    if (PROTOCOL_PARAMS.includes(key)) {
      throw new Error(
        `extraAuthorizationParams for provider "${providerName}" must not set protocol param "${key}"`,
      );
    }
  }

  /**
   * Start an OAuth sign-in. The server mints `state` and returns it;
   * the client keeps it (it must present the same value again to
   * complete sign-in) and navigates to the returned `redirect` URL.
   */
  const startSignIn = mutationGeneric({
    args: {
      redirectTo: v.string(),
    },
    returns: v.object({ redirect: v.string(), state: v.string() }),
    handler: async (ctx, args) => {
      const redirectTo = parseUrl(args.redirectTo);
      if (redirectTo === null) {
        throw new Error("redirectTo must be an absolute URL");
      }
      if (!allowedOrigins.includes(redirectTo.origin)) {
        throw new Error(
          `redirectTo origin "${redirectTo.origin}" is not in allowedRedirectOrigins`,
        );
      }

      const state = generateRandomToken();
      const codeVerifier = catalog.pkce ? generateRandomToken() : undefined;

      const stateHash = await sha256Hex(state);
      const { clientId, callbackUrl } = await ctx.runMutation(
        options.component.provider.createAuthorizationRequest,
        {
          providerName,
          stateHash,
          redirectTo: args.redirectTo,
          tokenEndpoint: catalog.tokenEndpoint,
          codeVerifier,
          userInfoEndpoints: catalog.userInfoEndpoints,
          issuer: catalog.issuer,
        },
      );

      const params: Record<string, string> = {
        ...options.extraAuthorizationParams,
        response_type: "code",
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
      };

      if (scopes.length > 0) {
        params.scope = scopes.join(" ");
      }

      if (codeVerifier !== undefined) {
        params.code_challenge = await sha256Base64Url(codeVerifier);
        params.code_challenge_method = "S256";
      }

      const url = new URL(catalog.authorizationEndpoint);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      return { redirect: url.toString(), state };
    },
  });

  /**
   * Complete an OAuth sign-in by redeeming the one-time `code` from
   * the callback redirect together with the state held since
   * `startSignIn`. The state must be the value stored at sign-in
   * time, never one read from a URL. Returns the session token
   * bundle, or null when the code is unknown, already redeemed,
   * expired, or the state doesn't match: all indistinguishable to
   * the caller, like a failed `refreshSession`.
   *
   * The component calls are subtransactions of this mutation, so a
   * failure anywhere (including the app rejecting the sign-in from
   * `createOrUpdateUser`) rolls back the ticket claim; only a
   * successful redemption consumes the ticket.
   */
  const completeSignIn = mutationGeneric({
    args: {
      code: v.string(),
      state: v.string(),
    },
    returns: v.union(vTokenBundle, v.null()),
    handler: async (ctx, args): Promise<TokenBundle | null> => {
      const ticket = await ctx.runMutation(
        options.component.provider.claimTicket,
        {
          providerName,
          ticketCodeHash: await sha256Hex(args.code),
          stateHash: await sha256Hex(args.state),
        },
      );
      if (ticket === null) {
        return null;
      }

      // Finding the ticket by hash proves `code` is the value the
      // payload was encrypted under, so decryption only fails on
      // corruption.
      const { claims, userInfoResponses } = JSON.parse(
        await decryptTicketPayload(args.code, ticket.payload),
      ) as {
        claims: OidcClaims | undefined;
        userInfoResponses: UserInfo | undefined;
      };

      const profile = catalog.profile(claims, userInfoResponses);
      if (typeof profile.id !== "string" || profile.id === "") {
        throw new Error(
          `Profile mapping for provider "${providerName}" returned no id`,
        );
      }

      return await helpers.completeSignIn(ctx, {
        provider: providerName,
        providerAccountId: profile.id,
        profile,
      });
    },
  });

  return { startSignIn, completeSignIn };
}
