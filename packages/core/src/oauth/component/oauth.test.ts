import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  // The single mount binds each provider's client credentials.
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
  vi.stubEnv("GITHUB_CLIENT_ID", "test-github-client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-client-secret");
  const t = convexTest(schema, modules);
  return t;
}

/** Args for a valid authorization request, overridable per test. */
const requestArgs = {
  providerName: "google",
  stateHash: "0".repeat(64),
  redirectTo: "https://app.example.com/after",
  callbackUrl: "https://test.convex.site/oauth/google/callback",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("oauth", () => {
  test("createAuthorizationRequest stores the request and returns the provider's client id", async () => {
    const t = setup();
    const result = await t.mutation(
      api.provider.createAuthorizationRequest,
      requestArgs,
    );
    expect(result).toEqual({
      clientId: "test-google-client-id",
    });
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(1);
    });
  });

  test("createAuthorizationRequest throws for an unsupported provider", async () => {
    const t = setup();
    await expect(
      t.mutation(api.provider.createAuthorizationRequest, {
        ...requestArgs,
        providerName: "myspace",
      }),
    ).rejects.toThrow(/Unsupported OAuth provider "myspace"/);
  });

  test("createAuthorizationRequest throws when the provider's credentials aren't bound", async () => {
    // Bind only Google; GitHub's pair is empty (unbound).
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.provider.createAuthorizationRequest, {
        ...requestArgs,
        providerName: "github",
        callbackUrl: "https://test.convex.site/oauth/github/callback",
      }),
    ).rejects.toThrow(/Bind GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET/);
  });

  test("claimAuthorizationRequest returns the request exactly once", async () => {
    const t = setup();
    await t.mutation(api.provider.createAuthorizationRequest, requestArgs);
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(claimed).toEqual({
      expired: false,
      providerName: "google",
      stateHash: requestArgs.stateHash,
      redirectTo: "https://app.example.com/after",
      callbackUrl: "https://test.convex.site/oauth/google/callback",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
    });
    const second = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(second).toBeNull();
  });

  test("claimAuthorizationRequest returns null for an unknown state hash", async () => {
    const t = setup();
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: "f".repeat(64) },
    );
    expect(claimed).toBeNull();
  });

  test("claimAuthorizationRequest deletes an expired request and returns only redirectTo", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.mutation(api.provider.createAuthorizationRequest, requestArgs);
    vi.advanceTimersByTime(11 * 60 * 1000);
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(claimed).toEqual({
      expired: true,
      redirectTo: "https://app.example.com/after",
    });
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(0);
    });
  });
});
