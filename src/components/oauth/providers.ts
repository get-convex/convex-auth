import {
  GitHub,
  Google,
  decodeIdToken,
  generateCodeVerifier,
} from "arctic";
import { env } from "./_generated/server";
import type { ProviderName } from "../../lib/oauth.js";
import type { AuthClaims } from "../../lib/types.js";

/**
 * The provider-specific halves of the flow, driven by Arctic. The handlers
 * `switch` on `PROVIDER` and run bespoke code per provider — deliberately not
 * behind a shared interface, since OAuth flows differ in ways (PKCE, where
 * the profile comes from, extra round-trips) that an interface would only
 * paper over. Adding a provider is a new `case` in each switch.
 */

/** The provider this instance drives, from its bound `PROVIDER` env var. */
export function provider(): ProviderName {
  // The generated type says the var is always bound, but a misconfigured (or
  // test) environment can still leave it unset, so validate as if untyped.
  const p = env.PROVIDER as string | undefined;
  if (p !== "google" && p !== "github") {
    throw new Error(`Unsupported OAuth PROVIDER: ${p ?? "(unset)"}`);
  }
  return p;
}

/** The OAuth client credentials, from this instance's bound env vars. */
function credentials(): { id: string; secret: string } {
  const id = env.OAUTH_CLIENT_ID;
  const secret = env.OAUTH_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      `${provider()} OAuth not configured. Bind OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET for this provider.`,
    );
  }
  return { id, secret };
}

/**
 * The redirect URI registered with the provider. Derived from
 * `CONVEX_SITE_URL`, which inside an http-prefixed component is
 * `https://<deployment>.convex.site<httpPrefix>` — so the default is this
 * instance's own `/callback` route and needs no configuration.
 * `OAUTH_REDIRECT_URI` overrides it (custom domain or proxy in front of the
 * deployment).
 */
export function redirectUri(): string {
  if (env.OAUTH_REDIRECT_URI) return env.OAUTH_REDIRECT_URI;
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl) {
    throw new Error(
      "Cannot derive the OAuth redirect URI. Mount the oauth component with an httpPrefix, or bind OAUTH_REDIRECT_URI.",
    );
  }
  return `${siteUrl.replace(/\/$/, "")}/callback`;
}

/**
 * A provider authorization URL for one flow, plus the PKCE verifier when the
 * provider uses one. The verifier is stored server-side keyed by `state` and
 * presented again during the code exchange.
 */
export function beginAuthorization(state: string): {
  url: string;
  codeVerifier?: string;
} {
  const p = provider();
  const { id, secret } = credentials();

  switch (p) {
    case "google": {
      const google = new Google(id, secret, redirectUri());
      const codeVerifier = generateCodeVerifier();
      const url = google.createAuthorizationURL(state, codeVerifier, [
        "openid",
        "profile",
        "email",
      ]);
      return { url: url.toString(), codeVerifier };
    }
    case "github": {
      const github = new GitHub(id, secret, redirectUri());
      const url = github.createAuthorizationURL(state, [
        "read:user",
        "user:email",
      ]);
      return { url: url.toString() };
    }
    default: {
      const _exhaustive: never = p;
      throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
    }
  }
}

interface GoogleIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * Exchange an authorization code for tokens, read the verified profile, and
 * normalize it into identity claims for the core component. Throws when the
 * exchange or profile fetch fails.
 */
export async function exchangeCode(opts: {
  code: string;
  codeVerifier?: string;
}): Promise<AuthClaims> {
  const p = provider();
  const { id, secret } = credentials();

  switch (p) {
    case "google": {
      const google = new Google(id, secret, redirectUri());
      const tokens = await google.validateAuthorizationCode(
        opts.code,
        opts.codeVerifier!,
      );
      // Decoding without signature verification is sound here: the ID token
      // came straight from Google's token endpoint over TLS with client
      // authentication, so its authenticity is established by the channel
      // (OIDC Core §3.1.3.7 permits skipping signature validation in exactly
      // this case).
      const claims = decodeIdToken(tokens.idToken()) as GoogleIdTokenClaims;
      return {
        provider: p,
        providerAccountId: claims.sub,
        profile: {
          email: claims.email,
          emailVerified: claims.email_verified ?? false,
          name: claims.name,
          picture: claims.picture,
          givenName: claims.given_name,
          familyName: claims.family_name,
        },
      };
    }
    case "github": {
      const github = new GitHub(id, secret, redirectUri());
      const tokens = await github.validateAuthorizationCode(opts.code);
      const accessToken = tokens.accessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "convex-auth",
        Accept: "application/vnd.github+json",
      };

      const userRes = await fetch("https://api.github.com/user", { headers });
      if (!userRes.ok) {
        throw new Error(`GitHub /user failed: ${userRes.status}`);
      }
      const user = (await userRes.json()) as GitHubUser;

      // The /user email is often null (private); the emails endpoint is the
      // reliable way to get a *verified* address.
      let email = user.email ?? undefined;
      let emailVerified = false;
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers,
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as GitHubEmail[];
        const chosen =
          emails.find((e) => e.primary && e.verified) ??
          emails.find((e) => e.verified);
        if (chosen) {
          email = chosen.email;
          emailVerified = chosen.verified;
        }
      }

      return {
        provider: p,
        providerAccountId: String(user.id),
        profile: {
          email,
          emailVerified,
          name: user.name ?? user.login,
          picture: user.avatar_url,
          username: user.login,
        },
      };
    }
    default: {
      const _exhaustive: never = p;
      throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
    }
  }
}
