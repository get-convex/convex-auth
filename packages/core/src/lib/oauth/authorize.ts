/**
 * The app-side start of an OAuth flow, shared by every provider.
 *
 * Every provider does the same three things here: check where the flow is
 * allowed to return to, mint the state that ties the callback back to this
 * client, and build the URL to send the browser to. What differs is the
 * endpoint and the scopes.
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import type {
  FunctionReference,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import { sha256Hex } from "../crypto.ts";
import { generateRandomToken, sha256Base64Url } from "./crypto.ts";
import type { CallbackMethod } from "./http.ts";
import { parseUrl } from "./redemption.ts";

type MutationCtx = GenericMutationCtx<GenericDataModel>;

type CreateAuthorizationRequestArgs = {
  stateHash: string;
  redirectTo: string;
  codeVerifier: string;
  includeProviderTokens?: boolean;
};

/**
 * The authorization parameters the flow itself sets. An app can't override
 * them: they carry the flow's security (`state`, PKCE, `redirect_uri`), its
 * identity (`client_id`), or what the callback is built to receive
 * (`response_type`, `response_mode`), and scopes go through `scopes`.
 */
export const RESERVED_AUTHORIZATION_PARAMS: readonly string[] = [
  "response_type",
  "response_mode",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
];

/**
 * What an app can add to a provider's authorization request, on top of what
 * the provider's own configuration asks for.
 *
 * For example, Google sign-up that also asks for calendar access, with a
 * refresh token:
 *
 * ```ts
 * {
 *   scopes: ["https://www.googleapis.com/auth/calendar.events"],
 *   authorizationParams: {
 *     access_type: "offline",
 *     prompt: "consent",
 *     include_granted_scopes: "true",
 *   },
 * }
 * ```
 */
export type OauthAuthorizationOptions = {
  /**
   * Scopes every sign-in asks for, on top of the ones the provider needs to
   * identify the user.
   */
  scopes?: string[];
  /**
   * Scopes a client may add to one sign-in with `startSignIn({ scopes })`,
   * for example to ask for calendar access only when the user turns the
   * feature on. A client can't ask for a scope outside this list or
   * `scopes`, so a compromised client can't widen what the app's OAuth
   * client is granted.
   */
  optionalScopes?: string[];
  /**
   * Extra query parameters for the authorization URL, e.g. Google's
   * `access_type: "offline"`, without which Google issues no refresh token.
   * A parameter the flow sets itself (see
   * {@link RESERVED_AUTHORIZATION_PARAMS}) is rejected at setup.
   */
  authorizationParams?: Record<string, string>;
};

/**
 * Check app-supplied authorization params at setup, so a mistake fails at
 * deploy time. Returns a copy.
 */
export function validateAuthorizationParams(
  params: Record<string, string> | undefined,
): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === "") {
      throw new Error("authorizationParams has an empty parameter name");
    }
    // Lowercased because some providers read parameter names loosely.
    if (RESERVED_AUTHORIZATION_PARAMS.includes(key.toLowerCase())) {
      throw new Error(
        `authorizationParams cannot set "${key}": the sign-in flow sets it itself` +
          (key.toLowerCase() === "scope" ? " (use `scopes` instead)" : ""),
      );
    }
    if (typeof value !== "string") {
      throw new Error(`authorizationParams "${key}" must be a string`);
    }
    validated[key] = value;
  }
  return validated;
}

/** Check a scope list at setup. A scope can't be empty or hold a space. */
function validateScopes(field: string, scopes: readonly string[]): void {
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope === "" || /\s/.test(scope)) {
      throw new Error(
        `${field} entry is not a valid scope: ${JSON.stringify(scope)}`,
      );
    }
  }
}

/** Longest `loginHint` accepted. An email address is at most 320. */
const MAX_LOGIN_HINT_LENGTH = 512;

type CreateAuthorizationRequestResult = {
  clientId: string;
  callbackUrl: string;
};

type CreateAuthorizationRequestRef = FunctionReference<
  "mutation",
  "internal",
  CreateAuthorizationRequestArgs,
  CreateAuthorizationRequestResult
>;

/**
 * Build a provider's `startSignIn` mutation.
 *
 * The server mints `state` and returns it; the client keeps it (it must
 * present the same value again to complete sign-in) and navigates to the
 * returned `redirect` URL.
 *
 * The mutation throws on every error. They are all developer or environment
 * errors, such as a `redirectTo` origin that isn't allowed, so there is
 * nothing for the user to correct.
 */
export function buildStartSignIn(options: {
  /** Origins `redirectTo` may point at, already validated and normalized. */
  allowedOrigins: string[];
  /** The provider's authorization endpoint (a full URL). */
  authorizationEndpoint: string;
  /**
   * Scopes the provider needs on every sign-in. Left off the URL entirely
   * when these, `authorization.scopes`, and the call's scopes are all empty.
   */
  scopes: readonly string[];
  /** What the app adds to the authorization request. */
  authorization?: OauthAuthorizationOptions;
  /**
   * Parameters the provider's own configuration adds to the authorization
   * URL. `authorization.authorizationParams` wins over these.
   */
  providerAuthorizationParams?: Record<string, string>;
  /**
   * Ask the callback to keep the provider's token response for the app, in
   * the encrypted ticket. Set exactly when the app attached
   * `onProviderTokens`.
   */
  includeProviderTokens?: boolean;
  /**
   * The method the provider delivers the callback with. `"POST"` adds
   * `response_mode=form_post` to the authorization URL.
   */
  callbackMethod?: CallbackMethod;
  /**
   * Record the request in the provider's component, and return what the
   * authorization URL needs.
   *
   * If the component's `createAuthorizationRequest` mutation takes exactly
   * {@link CreateAuthorizationRequestArgs}, pass its reference. If the
   * mutation takes more fields, pass a function that runs it with those
   * fields added.
   */
  createAuthorizationRequest:
    | CreateAuthorizationRequestRef
    | ((
        ctx: MutationCtx,
        args: CreateAuthorizationRequestArgs,
      ) => Promise<CreateAuthorizationRequestResult>);
}) {
  // Validated here, which runs at setup, so a mistake fails at deploy time.
  const extraParams = {
    ...validateAuthorizationParams(options.providerAuthorizationParams),
    ...validateAuthorizationParams(options.authorization?.authorizationParams),
  };
  const baseScopes = [
    ...new Set([...options.scopes, ...(options.authorization?.scopes ?? [])]),
  ];
  const optionalScopes = options.authorization?.optionalScopes ?? [];
  validateScopes("scopes", baseScopes);
  validateScopes("optionalScopes", optionalScopes);

  return mutationGeneric({
    args: {
      redirectTo: v.string(),
      /**
       * Scopes to add to this sign-in. Each must be in the setup's
       * `optionalScopes` (or already in its `scopes`).
       */
      scopes: v.optional(v.array(v.string())),
      /**
       * The account to preselect at the provider, sent as OIDC's
       * `login_hint`, e.g. the email of the account being reconnected.
       */
      loginHint: v.optional(v.string()),
    },
    returns: v.object({ redirect: v.string(), state: v.string() }),
    handler: async (ctx, args) => {
      const redirectTo = parseUrl(args.redirectTo);
      if (redirectTo === null) {
        throw new Error("redirectTo must be an absolute URL");
      }
      if (!options.allowedOrigins.includes(redirectTo.origin)) {
        throw new Error(
          `redirectTo origin "${redirectTo.origin}" is not in allowedRedirectOrigins`,
        );
      }

      const requestedScopes = args.scopes ?? [];
      for (const scope of requestedScopes) {
        if (!baseScopes.includes(scope) && !optionalScopes.includes(scope)) {
          throw new Error(
            `Scope ${JSON.stringify(scope)} is not in this provider's optionalScopes`,
          );
        }
      }
      const scopes = [...new Set([...baseScopes, ...requestedScopes])];
      if (
        args.loginHint !== undefined &&
        (args.loginHint === "" || args.loginHint.length > MAX_LOGIN_HINT_LENGTH)
      ) {
        throw new Error(
          `loginHint must be a non-empty string of at most ${MAX_LOGIN_HINT_LENGTH} characters`,
        );
      }

      const state = generateRandomToken();
      const codeVerifier = generateRandomToken();
      const requestArgs: CreateAuthorizationRequestArgs = {
        stateHash: await sha256Hex(state),
        redirectTo: args.redirectTo,
        codeVerifier,
        // Only written when set, so a flow that didn't ask stores what it
        // always did.
        ...(options.includeProviderTokens === true
          ? { includeProviderTokens: true }
          : {}),
      };
      // A function reference is a plain object at runtime, so `typeof` is
      // what tells the two apart.
      const { clientId, callbackUrl } =
        typeof options.createAuthorizationRequest === "function"
          ? await options.createAuthorizationRequest(ctx, requestArgs)
          : await ctx.runMutation(
              options.createAuthorizationRequest,
              requestArgs,
            );

      // The flow's own parameters go last, so nothing can override them.
      const params: Record<string, string> = {
        ...extraParams,
        ...(args.loginHint === undefined ? {} : { login_hint: args.loginHint }),
        response_type: "code",
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
        // Every provider gets a challenge. One that does not implement PKCE
        // ignores the parameters, which RFC 6749 requires of it.
        code_challenge: await sha256Base64Url(codeVerifier),
        code_challenge_method: "S256",
      };
      if (scopes.length > 0) {
        params.scope = scopes.join(" ");
      }
      if (options.callbackMethod === "POST") {
        params.response_mode = "form_post";
      }

      const url = new URL(options.authorizationEndpoint);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      return { redirect: url.toString(), state };
    },
  });
}
