import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  // Each per-IdP mount sees a CONVEX_SITE_URL prefixed with its http mount,
  // and its own client credential bindings.
  process.env.CONVEX_SITE_URL = "https://test.convex.site/oauth/google";
  process.env.CLIENT_ID = "test-client-id";
  process.env.CLIENT_SECRET = "test-client-secret";
  const t = convexTest(schema, modules);
  return t;
}

/** Args for a valid authorization request, overridable per test. */
const requestArgs = {
  provider: "google",
  stateHash: "0".repeat(64),
  redirectTo: "https://app.example.com/after",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("oauth", () => {
  test("createAuthorizationRequest stores the request and returns per-mount values", async () => {
    const t = setup();
    const result = await t.mutation(
      api.provider.createAuthorizationRequest,
      requestArgs,
    );
    expect(result).toEqual({
      callbackBaseUrl: "https://test.convex.site/oauth/google",
      clientId: "test-client-id",
    });
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(1);
      expect(requests[0].provider).toBe("google");
      expect(requests[0].stateHash).toBe("0".repeat(64));
      expect(requests[0].tokenEndpoint).toBe(
        "https://oauth2.googleapis.com/token",
      );
      expect(requests[0].codeVerifier).toBeUndefined();
      expect(requests[0].expiresAt).toBeGreaterThan(Date.now());
    });
  });

  test("claimAuthorizationRequest returns the request exactly once", async () => {
    const t = setup();
    await t.mutation(api.provider.createAuthorizationRequest, requestArgs);
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(claimed).toEqual({
      provider: "google",
      stateHash: requestArgs.stateHash,
      redirectTo: "https://app.example.com/after",
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

  test("claimAuthorizationRequest deletes but does not return an expired request", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.mutation(api.provider.createAuthorizationRequest, requestArgs);
    vi.advanceTimersByTime(11 * 60 * 1000);
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(claimed).toBeNull();
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(0);
    });
  });

  test("createTicket stores hashed one-time token with expiry", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      provider: "google",
      stateHash: "0".repeat(64),
      ottHash: "a".repeat(64),
      claims: { sub: "user-123", email: "user@example.com" },
    });
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(1);
      expect(tickets[0].ottHash).toBe("a".repeat(64));
      expect(tickets[0].claims).toEqual({
        sub: "user-123",
        email: "user@example.com",
      });
      expect(tickets[0].userInfoResponses).toBeUndefined();
      expect(tickets[0].expiresAt).toBeGreaterThan(Date.now());
    });
  });
});
