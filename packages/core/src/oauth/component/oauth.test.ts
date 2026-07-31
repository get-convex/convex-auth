import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  // One instance serving one provider: the mount binds the provider's name
  // and credentials. convex-test doesn't emulate mount env bindings, so the
  // component-side names are stubbed directly.
  vi.stubEnv("PROVIDER_NAME", "google");
  vi.stubEnv("CLIENT_ID", "test-client-id");
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
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
  test("createAuthorizationRequest stores the request and returns the mount's client id", async () => {
    const t = setup();
    const result = await t.mutation(
      api.provider.createAuthorizationRequest,
      requestArgs,
    );
    expect(result).toEqual({
      clientId: "test-client-id",
    });
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(1);
    });
  });

  test("createAuthorizationRequest throws when the provider doesn't match the mount", async () => {
    const t = setup();
    await expect(
      t.mutation(api.provider.createAuthorizationRequest, {
        ...requestArgs,
        providerName: "github",
      }),
    ).rejects.toThrow(/oauth mount bound to PROVIDER_NAME "google"/);
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
