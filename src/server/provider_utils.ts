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
  Provider as AuthProvider,
  EmailConfig,
  OAuthConfig,
  OAuthEndpointType,
  ProfileCallback,
} from "@auth/core/providers";
import { Profile } from "@auth/core/types";
import { AuthProviderMaterializedConfig, ConvexAuthConfig } from "./types";

/**
 * @internal
 */
export function configDefaults(config: ConvexAuthConfig) {
  setEnvDefaults(process.env, config as any);
  return {
    ...config,
    theme: config.theme ?? {
      colorScheme: "auto",
      logo: "",
      brandColor: "",
      buttonText: "",
    },
    providers: (config.providers as AuthProviderMaterializedConfig[]).map(
      providerDefaults,
    ),
  };
}

/**
 * @internal
 */
export function materializeProvider(provider: AuthProvider) {
  const config = { providers: [provider] };
  setEnvDefaults(process.env, config);
  return providerDefaults(
    config.providers[0] as AuthProviderMaterializedConfig,
  );
}

/**
 * @internal
 */
function providerDefaults(provider: AuthProviderMaterializedConfig) {
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

function normalizeEndpoint(
  e?: OAuthConfig<any>[OAuthEndpointType],
  issuer?: string,
) {
  if (!e && issuer) return;
  if (typeof e === "string") {
    return { url: new URL(e) };
  }
  const url = new URL(e?.url);
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

/**
 * @internal
 */
export async function getOAuthURLs(provider: OAuthConfig<any>) {
  if (
    provider.issuer &&
    (!provider.authorization || !provider.token || !provider.userinfo)
  ) {
    const discovery = `${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(discovery);
    const config = await response.json();
    return {
      authorization: { url: new URL(config.authorization_endpoint) },
      token: { url: new URL(config.token_endpoint) },
      userinfo: { url: new URL(config.userinfo_endpoint) },
    };
  }
  return provider;
}
