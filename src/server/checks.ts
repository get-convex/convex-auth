// Some code adapted from Auth.js. Original license:
//
// ISC License
//
// Copyright (c) 2022-2024, Balázs Orbán
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

import { generateState } from "arctic";
import * as o from "oauth4webapi";
import { InternalProvider } from "./oauth.js";

const SHARED_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "none" as const,
  secure: true,
  path: "/",
  partitioned: true,
};

export const state = {
  create(provider: InternalProvider) {
    const state = generateState();
    const cookie = {
      name: oauthStateCookieName("state", provider.id),
      value: state,
      options: { ...SHARED_COOKIE_OPTIONS, maxAge: STATE_MAX_AGE },
    };
    return { state, cookie };
  },

  use(provider: InternalProvider, cookies: Record<string, string | undefined>) {
    const cookieName = oauthStateCookieName("state", provider.id);
    const state = cookies[cookieName];

    if (state === undefined) {
      throw new Error("state cookie is missing.");
    }

    // Clear the state cookie after use
    const updatedCookie = {
      name: cookieName,
      value: "",
      options: { ...SHARED_COOKIE_OPTIONS, maxAge: 0 },
    };

    return { state, updatedCookie };
  },
};

const PKCE_MAX_AGE = 60 * 15; // 15 minutes in seconds
export const pkce = {
  async create(provider: InternalProvider) {
    const codeVerifier = o.generateRandomCodeVerifier();
    const codeChallenge = await o.calculatePKCECodeChallenge(codeVerifier);
    const cookie = {
      name: oauthStateCookieName("pkce", provider.id),
      value: codeVerifier,
      options: { ...SHARED_COOKIE_OPTIONS, maxAge: PKCE_MAX_AGE },
    };
    return { codeChallenge, codeVerifier, cookie };
  },
  /**
   * An error is thrown if the code_verifier is missing or invalid.
   * @see https://www.rfc-editor.org/rfc/rfc7636
   * @see https://danielfett.de/2020/05/16/pkce-vs-nonce-equivalent-or-not/#pkce
   */
  use(provider: InternalProvider, cookies: Record<string, string | undefined>) {
    const cookieName = oauthStateCookieName("pkce", provider.id);
    const codeVerifier = cookies[cookieName];

    if (codeVerifier === undefined) {
      throw new Error("pkce cookie is missing.");
    }

    // Clear the state cookie after use
    const updatedCookie = {
      name: cookieName,
      value: "",
      options: { ...SHARED_COOKIE_OPTIONS, maxAge: 0 },
    };

    return { codeVerifier, updatedCookie };
  },
};

const STATE_MAX_AGE = 60 * 15; // 15 minutes in seconds

function oauthStateCookieName(
  type: "state" | "pkce" | "nonce",
  providerId: string,
) {
  return "__Host-" + providerId + "OAuth" + type;
}

const NONCE_MAX_AGE = 60 * 15; // 15 minutes in seconds
export const nonce = {
  async create(provider: InternalProvider) {
    const nonce = o.generateRandomNonce();
    const cookie = {
      name: oauthStateCookieName("nonce", provider.id),
      value: nonce,
      options: { ...SHARED_COOKIE_OPTIONS, maxAge: NONCE_MAX_AGE },
    };
    return { nonce, cookie };
  },
  /**
   * An error is thrown if the nonce is missing or invalid.
   * @see https://openid.net/specs/openid-connect-core-1_0.html#NonceNotes
   * @see https://danielfett.de/2020/05/16/pkce-vs-nonce-equivalent-or-not/#nonce
   */
  use(provider: InternalProvider, cookies: Record<string, string | undefined>) {
    const cookieName = oauthStateCookieName("nonce", provider.id);
    const nonce = cookies[cookieName];

    if (nonce === undefined) {
      throw new Error("state cookie is missing.");
    }

    // Clear the state cookie after use
    const updatedCookie = {
      name: cookieName,
      value: "",
      options: { ...SHARED_COOKIE_OPTIONS, maxAge: 0 },
    };

    return { nonce, updatedCookie };
  },
};
