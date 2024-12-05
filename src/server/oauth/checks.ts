// This maps to packages/core/src/lib/actions/callback/oauth/checks.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431)

import * as o from "oauth4webapi";

import type { InternalOptions } from "./types.js";
import { Cookie } from "@auth/core/lib/utils/cookie.js";
import { CookiesOptions } from "@auth/core/types.js";
import { logWithLevel } from "../implementation/utils.js";

const COOKIE_TTL = 60 * 15; // 15 minutes

/** Returns a cookie with the given payload and options. */
// ConvexAuth: Auth.js calls this `sealCookie` and encrypts the payload wrapped in a JWT.
async function createCookie(
  name: keyof CookiesOptions,
  payload: string,
  options: InternalOptions<"oauth" | "oidc">,
): Promise<Cookie> {
  const { cookies } = options;
  const cookie = cookies[name];
  const expires = new Date();
  expires.setTime(expires.getTime() + COOKIE_TTL * 1000);

  logWithLevel("DEBUG", `CREATE_${name.toUpperCase()}`, {
    name: cookie.name,
    payload,
    COOKIE_TTL,
    expires,
  });

  const cookieOptions = { ...cookie.options, expires };

  return { name: cookie.name, value: payload, options: cookieOptions };
}

function clearCookie(
  name: keyof CookiesOptions,
  options: InternalOptions<"oauth" | "oidc">,
  resCookies: Cookie[],
) {
  const { cookies } = options;
  const cookie = cookies[name];
  logWithLevel("DEBUG", `CLEAR_${name.toUpperCase()}`, { cookie });
  resCookies.push({
    name: cookie.name,
    value: "",
    options: { ...cookies[name].options, maxAge: 0 },
  });
}

function useCookie(
  check: "state" | "pkce" | "nonce",
  name: keyof CookiesOptions,
) {
  return async function (
    // ConvexAuth: `cookies` is a Record<string, string | undefined> instead of RequestInternal["cookies"]
    cookies: Record<string, string | undefined>,
    resCookies: Cookie[],
    options: InternalOptions<"oidc">,
  ) {
    const { provider } = options;
    if (!provider?.checks?.includes(check)) return;
    const cookieValue = cookies?.[options.cookies[name].name];
    logWithLevel("DEBUG", `USE_${name.toUpperCase()}`, { value: cookieValue });
    clearCookie(name, options, resCookies);
    return cookieValue;
  };
}

/**
 * @see https://www.rfc-editor.org/rfc/rfc7636
 * @see https://danielfett.de/2020/05/16/pkce-vs-nonce-equivalent-or-not/#pkce
 */
export const pkce = {
  /** Creates a PKCE code challenge and verifier pair. The verifier is stored in the cookie. */
  async create(options: InternalOptions<"oauth">) {
    const codeVerifier = o.generateRandomCodeVerifier();
    const codeChallenge = await o.calculatePKCECodeChallenge(codeVerifier);
    const cookie = await createCookie("pkceCodeVerifier", codeVerifier, options);
    return { cookie, codeChallenge: codeChallenge, codeVerifier };
  },
  /**
   * Returns code_verifier if the provider is configured to use PKCE,
   * and clears the container cookie afterwards.
   * An error is thrown if the code_verifier is missing or invalid.
   */
  use: useCookie("pkce", "pkceCodeVerifier"),
};

/**
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-10.12
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-4.1.1
 */
export const state = {
  /** Creates a state cookie with an optionally encoded body. */
  async create(options: InternalOptions<"oauth">, origin?: string) {
    const { provider } = options;
    if (!provider.checks.includes("state")) {
      if (origin) {
        throw new Error(
          "State data was provided but the provider is not configured to use state",
        );
      }
      return;
    }

    const payload = o.generateRandomState();
    const cookie = await createCookie("state", payload, options);
    return { cookie, value: payload };
  },
  /**
   * Returns state if the provider is configured to use state,
   * and clears the container cookie afterwards.
   * An error is thrown if the state is missing or invalid.
   */
  use: useCookie("state", "state"),
};

export const nonce = {
  async create(options: InternalOptions<"oidc">) {
    if (!options.provider.checks.includes("nonce")) return;
    const value = o.generateRandomNonce();
    const cookie = await createCookie("nonce", value, options);
    return { cookie, value };
  },
  /**
   * Returns nonce if the provider is configured to use nonce,
   * and clears the container cookie afterwards.
   * An error is thrown if the nonce is missing or invalid.
   * @see https://openid.net/specs/openid-connect-core-1_0.html#NonceNotes
   * @see https://danielfett.de/2020/05/16/pkce-vs-nonce-equivalent-or-not/#nonce
   */
  use: useCookie("nonce", "nonce"),
};

// ConvexAuth: All WebAuthn checks are omitted.
