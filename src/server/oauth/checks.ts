// This maps to packages/core/src/lib/actions/callback/oauth/checks.ts in the @auth/core package.

import { InternalOptions } from "./types.js";
import * as o from "oauth4webapi";
import { encode, decode } from "@auth/core/jwt";
import { CookiesOptions } from "@auth/core/types.js";
import { Cookie } from "@auth/core/lib/utils/cookie.js";

interface CookiePayload {
  value: string;
}

const COOKIE_TTL = 60 * 15; // 15 minutes

/** Returns a cookie with a JWT encrypted payload. */
async function sealCookie(
  name: keyof CookiesOptions,
  payload: string,
  options: InternalOptions<"oauth" | "oidc">,
): Promise<Cookie> {
  const { cookies } = options;
  const cookie = cookies[name];
  const expires = new Date();
  expires.setTime(expires.getTime() + COOKIE_TTL * 1000);
  // TODO(ConvexAuth): Add debug logging

  const encoded = await encode({
    ...options.jwt,
    maxAge: COOKIE_TTL,
    token: { value: payload } satisfies CookiePayload,
    salt: cookie.name,
  });
  const cookieOptions = { ...cookie.options, expires };
  return { name: cookie.name, value: encoded, options: cookieOptions };
}

async function parseCookie(
  name: keyof CookiesOptions,
  value: string | undefined,
  options: InternalOptions<"oauth" | "oidc">,
): Promise<string> {
  try {
    const { cookies, jwt } = options;
    // TODO(ConvexAuth): Add debug logging

    if (!value) throw new Error(`${name} cookie was missing`);
    const parsed = await decode<CookiePayload>({
      ...jwt,
      token: value,
      salt: cookies[name].name,
    });
    if (parsed?.value) return parsed.value;
    throw new Error("Invalid cookie");
  } catch (error) {
    throw new Error(`${name} value could not be parsed`, {
      cause: error,
    });
  }
}

function clearCookie(
  name: keyof CookiesOptions,
  options: InternalOptions<"oauth" | "oidc">,
  resCookies: Cookie[],
) {
  const { cookies } = options;
  const cookie = cookies[name];
  // TODO(ConvexAuth): Add debug logging
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
    cookies: Record<string, string>,
    resCookies: Cookie[],
    options: InternalOptions<"oidc">,
  ) {
    const { provider } = options;
    if (!provider?.checks?.includes(check)) return;
    const cookieValue = cookies?.[options.cookies[name].name];
    // TODO(ConvexAuth): Add debug logging
    const parsed = await parseCookie(name, cookieValue, options);
    clearCookie(name, options, resCookies);
    return parsed;
  };
}

/**
 * @see https://www.rfc-editor.org/rfc/rfc7636
 * @see https://danielfett.de/2020/05/16/pkce-vs-nonce-equivalent-or-not/#pkce
 */
export const pkce = {
  /** Creates a PKCE code challenge and verifier pair. The verifier in stored in the cookie. */
  async create(options: InternalOptions<"oauth">) {
    const code_verifier = o.generateRandomCodeVerifier();
    const value = await o.calculatePKCECodeChallenge(code_verifier);
    const cookie = await sealCookie("pkceCodeVerifier", code_verifier, options);
    return { cookie, value };
  },
  /**
   * Returns code_verifier if the provider is configured to use PKCE,
   * and clears the container cookie afterwards.
   * An error is thrown if the code_verifier is missing or invalid.
   */
  use: useCookie("pkce", "pkceCodeVerifier"),
};

interface EncodedState {
  origin?: string;
  random: string;
}

const STATE_MAX_AGE = 60 * 15; // 15 minutes in seconds
const encodedStateSalt = "encodedState";

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

    // IDEA: Allow the user to pass data to be stored in the state
    const payload = {
      origin,
      random: o.generateRandomState(),
    } satisfies EncodedState;
    const value = await encode({
      secret: options.jwt.secret,
      token: payload,
      salt: encodedStateSalt,
      maxAge: STATE_MAX_AGE,
    });
    const cookie = await sealCookie("state", value, options);

    return { cookie, value };
  },
  /**
   * Returns state if the provider is configured to use state,
   * and clears the container cookie afterwards.
   * An error is thrown if the state is missing or invalid.
   */
  use: useCookie("state", "state"),
  /** Decodes the state. If it could not be decoded, it throws an error. */
  async decode(state: string, options: InternalOptions<"oauth" | "oidc">) {
    try {
      // TODO(ConvexAuth): Add debug logging

      const payload = await decode<EncodedState>({
        secret: options.jwt.secret,
        token: state,
        salt: encodedStateSalt,
      });
      if (payload) return payload;
      throw new Error("Invalid state");
    } catch (error) {
      throw new Error("State could not be decoded", { cause: error });
    }
  },
};

export const nonce = {
  async create(options: InternalOptions<"oidc">) {
    if (!options.provider.checks.includes("nonce")) return;
    const value = o.generateRandomNonce();
    const cookie = await sealCookie("nonce", value, options);
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
