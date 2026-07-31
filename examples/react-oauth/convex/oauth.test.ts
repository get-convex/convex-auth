import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerOauth } from "@convex-dev/auth/providers/testing/oauth";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

async function setup(provider: "google" | "github" = "google") {
  // The core signs JWTs from these env vars (see core/public.ts). Mint a real
  // RS256 key pair for each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);

  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(pkcs8));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );
  // convex-test doesn't emulate mount env bindings or the backend's
  // mount-prefixed CONVEX_SITE_URL override, so all registered instances
  // read the same process.env. Each test exercises one provider, so stub
  // that provider's mount env (CONVEX_SITE_URL with the prefix already
  // applied, as the backend would present it to the oauth mount — no
  // exercised path reads the core's value); values stay distinct per
  // provider so assertions pin the provider under test. They can't catch
  // wrong-mount wiring: every mount reads this same process.env.
  vi.stubEnv("CLIENT_ID", `test-${provider}-client-id`);
  vi.stubEnv("CLIENT_SECRET", `test-${provider}-client-secret`);
  vi.stubEnv(
    "CONVEX_SITE_URL",
    `https://example.convex.site/oauth/${provider}`,
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerOauth(t, "oauthGoogle");
  registerOauth(t, "oauthGithub");
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// The full callback flow (code exchange, ticket mint) runs over the
// component's HTTP route, which app-level convex-test doesn't serve; it's
// covered by the component's own tests (oauth/component/http.test.ts in the
// library). These tests cover the app-facing mutations.
describe("oauth", () => {
  test("startSignIn returns the authorization URL and the minted state", async () => {
    const t = await setup();
    const { redirect, state } = await t.mutation(api.auth.startSignInGoogle, {
      redirectTo: "http://localhost:5173/",
    });
    expect(state).toEqual(expect.any(String));
    const url = new URL(redirect);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.convex.site/oauth/google/callback",
    );
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code_challenge")).toEqual(expect.any(String));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("startSignIn rejects a redirectTo outside allowedRedirectOrigins", async () => {
    const t = await setup();
    await expect(
      t.mutation(api.auth.startSignInGoogle, {
        redirectTo: "https://evil.example.com/after",
      }),
    ).rejects.toThrow("not in allowedRedirectOrigins");
  });

  test("completeSignIn returns null for an unknown code", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.completeSignInGoogle, {
      code: "not-a-real-code",
      state: "not-a-real-state",
    });
    expect(result).toBeNull();
  });

  test("github startSignIn returns its own authorization URL", async () => {
    const t = await setup("github");
    const { redirect, state } = await t.mutation(api.auth.startSignInGithub, {
      redirectTo: "http://localhost:5173/",
    });
    const url = new URL(redirect);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-github-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.convex.site/oauth/github/callback",
    );
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code_challenge")).toEqual(expect.any(String));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("github completeSignIn returns null for an unknown code", async () => {
    const t = await setup("github");
    const result = await t.mutation(api.auth.completeSignInGithub, {
      code: "not-a-real-code",
      state: "not-a-real-state",
    });
    expect(result).toBeNull();
  });
});
