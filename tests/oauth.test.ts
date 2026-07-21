import { api } from "@convex/_generated/api";
import schema from "@convex/schema";
import { custom } from "@robelest/convex-auth/providers";
import {
  OAUTH_SIGN_IN_CODE_ALPHABET,
  OAUTH_SIGN_IN_CODE_LENGTH,
} from "@robelest/convex-auth/server/mutations/oauth";
import { generateRandomString } from "@robelest/convex-auth/server/random";
import { expect, test, vi } from "vite-plus/test";

import { convexTest } from "./convex/setup";

test("sign up with oauth starts redirect flow", async () => {
  const t = convexTest(schema);

  const result = await t.action(api.auth.signIn, {
    provider: "google",
  });

  expect(result.kind).toBe("redirect");
  if (result.kind !== "redirect") {
    throw new Error(`Expected redirect, got: ${JSON.stringify(result)}`);
  }

  const redirect = new URL(result.redirect);
  expect(redirect.origin).toBe(process.env.CONVEX_SITE_URL);
  expect(redirect.pathname).toBe("/auth/signin/google");
  expect(redirect.searchParams.get("code")).toBe(result.verifier);
});

test("sign in with oauth issues a fresh verifier", async () => {
  const t = convexTest(schema);

  const first = await t.action(api.auth.signIn, { provider: "google" });
  const second = await t.action(api.auth.signIn, { provider: "google" });

  expect(first.kind).toBe("redirect");
  expect(second.kind).toBe("redirect");
  if (first.kind !== "redirect" || second.kind !== "redirect") {
    throw new Error("Expected redirect sign-in results.");
  }

  expect(first.verifier).toBeDefined();
  expect(second.verifier).toBeDefined();
  expect(second.verifier).not.toEqual(first.verifier);
});

test("redirectTo with oauth preserves auth redirect semantics", async () => {
  const t = convexTest(schema);

  const result = await t.action(api.auth.signIn, {
    provider: "google",
    params: {
      redirectTo: "/dashboard",
    },
  });

  expect(result.kind).toBe("redirect");
  if (result.kind !== "redirect") {
    throw new Error(`Expected redirect, got: ${JSON.stringify(result)}`);
  }

  const redirect = new URL(result.redirect);
  expect(redirect.origin).toBe(process.env.CONVEX_SITE_URL);
  expect(redirect.pathname).toBe("/auth/signin/google");
  expect(redirect.searchParams.get("code")).toBe(result.verifier);
});

test("custom oauth provider builds authorization URL from stable config", async () => {
  const provider = custom({
    id: "discord",
    clientId: "discord-client-id",
    clientSecret: "discord-client-secret",
    redirectUri: "https://app.example.com/api/auth/callback/discord",
    authorization: {
      url: "https://discord.com/oauth2/authorize",
      pkce: "optional",
      clientIdParam: "client_key",
      scopeSeparator: ",",
      extraParams: { prompt: "consent" },
    },
    token: {
      url: "https://discord.com/api/oauth2/token",
      authMethod: "body",
    },
  });

  const url = provider.provider!.createAuthorizationURL({
    state: "test-state",
    codeVerifier: "test-code-verifier",
    scopes: ["identify", "email"],
    nonce: "test-nonce",
  });

  expect(url.toString()).toContain("https://discord.com/oauth2/authorize");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_key")).toBe("discord-client-id");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://app.example.com/api/auth/callback/discord",
  );
  expect(url.searchParams.get("state")).toBe("test-state");
  expect(url.searchParams.get("scope")).toBe("identify,email");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("nonce")).toBe("test-nonce");
  expect(url.searchParams.get("prompt")).toBe("consent");
});

test("custom oauth provider exchanges code with configurable token request", async () => {
  vi.unstubAllGlobals();
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        expires_in: 3600,
        scope: "identify,email",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const provider = custom({
    id: "tiktok",
    clientId: "tiktok-client-id",
    clientSecret: "tiktok-client-secret",
    redirectUri: "https://app.example.com/api/auth/callback/tiktok",
    scopes: ["user.info.basic", "video.list"],
    authorization: {
      url: "https://www.tiktok.com/v2/auth/authorize/",
      pkce: "required",
      clientIdParam: "client_key",
      scopeSeparator: ",",
    },
    token: {
      url: "https://open.tiktokapis.com/v2/oauth/token/",
      authMethod: "body",
      clientIdParam: "client_key",
      includeScopes: true,
      scopeSeparator: ",",
      extraParams: { audience: "users.read" },
    },
  });

  const tokens = await provider.provider!.validateAuthorizationCode({
    code: "oauth-code",
    codeVerifier: "oauth-verifier",
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toBeInstanceOf(Headers);
  expect(init?.body).toBeInstanceOf(URLSearchParams);

  const body = init?.body as URLSearchParams;
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("oauth-code");
  expect(body.get("redirect_uri")).toBe("https://app.example.com/api/auth/callback/tiktok");
  expect(body.get("code_verifier")).toBe("oauth-verifier");
  expect(body.get("client_key")).toBe("tiktok-client-id");
  expect(body.get("client_secret")).toBe("tiktok-client-secret");
  expect(body.get("scope")).toBe("user.info.basic,video.list");
  expect(body.get("audience")).toBe("users.read");

  expect(tokens.accessToken).toBe("access-token");
  expect(tokens.refreshToken).toBe("refresh-token");
  expect(tokens.idToken).toBe("id-token");
  expect(tokens.accessTokenExpiresAt).toBeInstanceOf(Date);
  expect(tokens.scopes).toEqual(["identify", "email"]);
  expect(tokens.raw).toEqual(expect.objectContaining({ access_token: "access-token" }));

  vi.unstubAllGlobals();
});

test("custom oauth provider leaves access token expiry undefined when expires_in is omitted", async () => {
  vi.unstubAllGlobals();
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        scope: "identify,email",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const provider = custom({
    id: "github-like",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://app.example.com/api/auth/callback/github-like",
    authorization: {
      url: "https://example.com/oauth/authorize",
    },
    token: {
      url: "https://example.com/oauth/token",
    },
  });

  const tokens = await provider.provider!.validateAuthorizationCode({
    code: "oauth-code",
  });

  expect(tokens.accessToken).toBe("access-token");
  expect(tokens.refreshToken).toBe("refresh-token");
  expect(tokens.accessTokenExpiresAt).toBeUndefined();
  expect(tokens.scopes).toEqual(["identify", "email"]);

  vi.unstubAllGlobals();
});

test("oauth sign-in handoff code is a 32-char high-entropy alphanumeric code", () => {
  // Regression: the OAuth sign-in handoff code was an 8-digit numeric string
  // (~26.6 bits), brute-forceable within its 2-minute TTL. It must now follow
  // the 32-char alphanumeric OAuth-code convention used elsewhere (~190 bits).
  expect(OAUTH_SIGN_IN_CODE_LENGTH).toBe(32);
  expect(OAUTH_SIGN_IN_CODE_ALPHABET).toMatch(/^[A-Za-z0-9]+$/);
  expect(new Set(OAUTH_SIGN_IN_CODE_ALPHABET).size).toBe(62);

  const code = generateRandomString(OAUTH_SIGN_IN_CODE_LENGTH, OAUTH_SIGN_IN_CODE_ALPHABET);
  expect(code).toMatch(/^[A-Za-z0-9]{32}$/);
});
