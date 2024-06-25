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

import { setEnvDefaults } from "@auth/core";
import {
  AccountCallback,
  EmailConfig,
  OAuthConfig,
  OAuthEndpointType,
  ProfileCallback,
} from "@auth/core/providers";
import { Profile } from "@auth/core/types";
import {
  AuthProviderConfig,
  AuthProviderMaterializedConfig,
  ConvexAuthConfig,
} from "./types.js";

/**
 * @internal
 */
export function configDefaults(config_: ConvexAuthConfig) {
  const config = materializeAndDefaultProviders(config_);
  return {
    ...config,
    theme: config.theme ?? {
      colorScheme: "auto",
      logo: "",
      brandColor: "",
      buttonText: "",
    },
  };
}

/**
 * @internal
 */
export function materializeProvider(provider: AuthProviderConfig) {
  const config = { providers: [provider] };
  materializeAndDefaultProviders(config);
  return providerDefaults(
    config.providers[0] as AuthProviderMaterializedConfig,
  );
}

function materializeAndDefaultProviders(config_: ConvexAuthConfig) {
  // Have to materialize first so that the correct env variables are used
  const providers = config_.providers.map((provider) =>
    providerDefaults(
      typeof provider === "function" ? provider() : (provider as any),
    ),
  );
  const config = { ...config_, providers };

  // Unfortunately mutates its argument
  setEnvDefaults(process.env, config as any);
  // Manually do this for new provider type
  config.providers.forEach((provider) => {
    if (provider.type === "phone") {
      const ID = provider.id.toUpperCase().replace(/-/g, "_");
      provider.apiKey ??= process.env[`AUTH_${ID}_KEY`];
    }
  });
  return config;
}

function providerDefaults(provider: AuthProviderMaterializedConfig) {
  // TODO: Add `redirectProxyUrl` to oauth providers
  return merge(
    provider.type === "oauth" || provider.type === "oidc"
      ? normalizeOAuth(provider)
      : provider,
    (provider as any).options,
  ) as AuthProviderMaterializedConfig;
}

const defaultProfile: ProfileCallback<Profile> = (profile) => {
  return stripUndefined({
    id: profile.sub ?? profile.id ?? crypto.randomUUID(),
    name: profile.name ?? profile.nickname ?? profile.preferred_username,
    email: profile.email,
    image: profile.picture,
  });
};

const defaultAccount: AccountCallback = (account) => {
  return stripUndefined({
    access_token: account.access_token,
    id_token: account.id_token,
    refresh_token: account.refresh_token,
    expires_at: account.expires_at,
    scope: account.scope,
    token_type: account.token_type,
    session_state: account.session_state,
  });
};

function stripUndefined<T extends object>(o: T): T {
  const result = {} as any;
  for (const [k, v] of Object.entries(o)) v !== undefined && (result[k] = v);
  return result as T;
}

function normalizeOAuth(c: any): EmailConfig {
  if (c.issuer) c.wellKnown ??= `${c.issuer}/.well-known/openid-configuration`;

  const authorization = normalizeEndpoint(c.authorization, c.issuer);
  if (authorization && !authorization.url?.searchParams.has("scope")) {
    authorization.url.searchParams.set("scope", "openid profile email");
  }

  const token = normalizeEndpoint(c.token, c.issuer);

  const userinfo = normalizeEndpoint(c.userinfo, c.issuer);

  const checks = c.checks ?? ["pkce"];
  if (c.redirectProxyUrl) {
    if (!checks.includes("state")) checks.push("state");
    c.redirectProxyUrl = `${c.redirectProxyUrl}/callback/${c.id}`;
  }

  return {
    ...c,
    authorization,
    token,
    checks,
    userinfo,
    profile: c.profile ?? defaultProfile,
    account: c.account ?? defaultAccount,
  };
}

export const PLACEHOLDER_URL = "https://convexauth.mumbojumbo";

function normalizeEndpoint(
  e?: OAuthConfig<any>[OAuthEndpointType],
  issuer?: string,
) {
  if (!e && issuer) return undefined;
  if (typeof e === "string") {
    return { url: new URL(e) };
  }
  // Placeholder URL is used to pass around the URL object
  // even if the URL hasn't been specified: the `issuer`
  // is used instead.
  const url = new URL(e?.url ?? PLACEHOLDER_URL);
  if (e?.params != null) {
    for (const [key, value] of Object.entries(e.params)) {
      url.searchParams.set(
        key,
        String(key === "claims" ? JSON.stringify(value) : value),
      );
    }
  }
  return { url, request: e?.request, conform: e?.conform };
}

// Source: https://stackoverflow.com/a/34749873/5364135

/**
 * Deep merge two objects
 *
 * @internal
 */
export function merge(target: any, ...sources: any[]): any {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        merge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return merge(target, ...sources);
}

/** Simple object check */
function isObject(item: any): boolean {
  return item && typeof item === "object" && !Array.isArray(item);
}
