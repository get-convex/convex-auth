import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import {
  vTokenBundle,
  type TokenBundle,
  type UserCallbacks,
} from "../../lib/types";
import type { AuthCore } from "../../components/core/setup";
import type { ComponentApi } from "./_generated/component.js";
import {
  decryptTicketPayload,
  generateRandomToken,
  sha256Base64Url,
} from "./crypto";
import { sha256Hex } from "../../lib/crypto";

/**
 * Standard OIDC id_token claims. The well-known ones are typed. Any other
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
 * Map what the provider attested about the user to the account identity used
 * at redemption. `claims` holds the id_token claims (`undefined` for
 * non-OIDC providers). `userInfoResponses` holds the userinfo responses
 * keyed as configured (`undefined` unless the catalog sets
 * `userInfoEndpoints`). `id` becomes the provider account id. Supplied by
 * each provider's catalog (see `google.ts`, `github.ts`).
 *
 * `Profile` is the exact shape the mapping emits, which is what the app's
 * create-or-update-user callback receives.
 *
 * `UserInfo` is the catalog's declared shape for the userinfo responses,
 * keyed like `userInfoEndpoints`. It types what the provider is trusted to
 * return. The responses are provider-attested JSON and are not validated
 * against it at runtime.
 */
export type OauthProfile<
  Profile extends { id: string } = { id: string } & Record<string, unknown>,
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
> = (
  claims: OidcClaims | undefined,
  userInfoResponses: UserInfo | undefined,
) => Profile;

/**
 * Provider-defined config for interacting with an individual OAuth provider.
 *
 * `UserInfo` declares the shape of the userinfo responses, tying
 * `userInfoEndpoints` keys to what `profile` receives (see
 * {@link OauthProfile}).
 */
export type OauthCatalog<
  Profile extends { id: string } = { id: string } & Record<string, unknown>,
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
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
   * Google's `https://accounts.google.com`. Some providers document more than
   * one form (Google also uses `accounts.google.com`); an array accepts any
   * of them. Present for OIDC providers; absent for plain-OAuth providers
   * (e.g., GitHub), where identity comes from userinfo.
   */
  issuer?: string | string[];
  /**
   * Endpoints (full URLs) the callback fetches with the access token (GET
   * with a bearer token), keyed by the name the `profile` mapping reads
   * each response under. Present for providers whose identity comes from
   * userinfo (GitHub). The keys must match `UserInfo`'s.
   */
  userInfoEndpoints?: { [K in keyof UserInfo & string]: string };
  /** Scopes to request. */
  scopes: string[];
  /**
   * Send a PKCE `S256` challenge with the authorization request. Enable it for
   * providers that support PKCE alongside the client secret.
   */
  pkce: boolean;
  /** Map the provider's attested identity to the account profile. */
  profile: OauthProfile<Profile, UserInfo>;
};

/**
 * App-defined config for setting up an OAuth provider and passing in options.
 */
export type OauthProviderOptions = {
  /**
   * This provider's oauth component instance, e.g. `components.oauthGoogle`.
   * The component is installed once per provider.
   */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/** `new URL` without the exception: returns null on unparseable input. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Set up OAuth sign-in against a single upstream identity provider.
 *
 * The flow:
 *
 * 1. `startSignIn` (here): validate, mint `state`, record an authorization
 *    request in the component, and return the provider authorization URL for
 *    the client to navigate to plus the state it must hold onto.
 * 2. The provider redirects back to the component's HTTP callback
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
  Provider extends string,
  Profile extends { id: string },
  UsersTable extends string,
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
>(
  core: AuthCore<UsersTable>,
  providerName: Provider,
  catalog: OauthCatalog<Profile, UserInfo>,
  callbacks: UserCallbacks<Provider, Profile, UsersTable>,
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
    // An entry with a path would silently allow the whole origin, which is
    // broader than what the config appears to say. Require bare origins.
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error(
        `allowedRedirectOrigins entry must be a bare origin with no path, ` +
          `query, or fragment: "${allowed}" (use "${url.origin}" to allow ` +
          `the whole origin)`,
      );
    }
    return url.origin;
  });
  const issuers =
    catalog.issuer === undefined
      ? undefined
      : Array.isArray(catalog.issuer)
        ? catalog.issuer
        : [catalog.issuer];
  // Per OIDC, requesting the `openid` scope makes the provider return an
  // id_token, which must be validated against an expected issuer.
  if (catalog.scopes.includes("openid") && (issuers?.length ?? 0) === 0) {
    throw new Error(
      `Provider "${providerName}" requests the "openid" scope, so the provider will return an id_token, but its catalog sets no issuer to validate it against`,
    );
  }

  const { authMutation } = core.bindProvider({
    name: providerName,
    createUser: callbacks.createUser,
    onSignIn: callbacks.onSignIn,
  });

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
          issuers,
        },
      );

      const params: Record<string, string> = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
      };

      if (catalog.scopes.length > 0) {
        params.scope = catalog.scopes.join(" ");
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
   * `startSignIn`. Returns the session token bundle, or null when
   * the code is unknown, already redeemed, expired, or the state
   * doesn't match: all indistinguishable to the caller.
   *
   * The component calls are subtransactions of this mutation, so a
   * failure anywhere (including the app rejecting the sign-in from
   * `createUser` / `onSignIn`) rolls back the ticket claim. Only a
   * successful redemption consumes the ticket.
   */
  // TODO: dowski - return the shared `vSignInSuccess` envelope like the other
  // providers do, instead of a bare bundle or null.
  const completeSignIn = authMutation({
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
        await decryptTicketPayload(args.code, ticket.encryptedPayload),
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

      // The same redemption flow serves a first sign-in and a return visit, so
      // resolve the identity to pick a path. This handler is a mutation, so the
      // lookup and the write it decides on are one transaction.
      const existingUserId = await ctx.convexAuth.resolveUserId(profile.id);
      return existingUserId === null
        ? await ctx.convexAuth.completeSignUp({
            providerAccountId: profile.id,
            profile,
          })
        : await ctx.convexAuth.completeSignIn({
            providerAccountId: profile.id,
            profile,
          });
    },
  });

  return { startSignIn, completeSignIn };
}
