import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
  decryptWithToken,
  encryptWithToken,
  generateRandomToken,
} from "./crypto.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  // Each per-IdP mount sees a CONVEX_SITE_URL prefixed with its http mount,
  // and its own client credential bindings.
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/oauth/google");
  vi.stubEnv("CLIENT_ID", "test-client-id");
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
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
  vi.unstubAllEnvs();
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
      expired: false,
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

  test("createTicket stores hashed one-time token with expiry", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      provider: "google",
      stateHash: "0".repeat(64),
      ottHash: "a".repeat(64),
      payload: "encrypted-payload",
    });
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(1);
      expect(tickets[0].ottHash).toBe("a".repeat(64));
      expect(tickets[0].payload).toBe("encrypted-payload");
      expect(tickets[0].expiresAt).toBeGreaterThan(Date.now());
    });
  });

  test("claimTicket returns the ticket exactly once", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      provider: "google",
      stateHash: "0".repeat(64),
      ottHash: "a".repeat(64),
      payload: "encrypted-payload",
    });
    const claimed = await t.mutation(api.provider.claimTicket, {
      provider: "google",
      ottHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(claimed).toEqual({ payload: "encrypted-payload" });
    const second = await t.mutation(api.provider.claimTicket, {
      provider: "google",
      ottHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(second).toBeNull();
  });

  test("claimTicket returns null on state mismatch and preserves the ticket", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      provider: "google",
      stateHash: "0".repeat(64),
      ottHash: "a".repeat(64),
      payload: "encrypted-payload",
    });
    const claimed = await t.mutation(api.provider.claimTicket, {
      provider: "google",
      ottHash: "a".repeat(64),
      stateHash: "f".repeat(64),
    });
    expect(claimed).toBeNull();
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(1);
    });
  });

  test("claimTicket returns null on provider mismatch and preserves the ticket", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      provider: "google",
      stateHash: "0".repeat(64),
      ottHash: "a".repeat(64),
      payload: "encrypted-payload",
    });
    const claimed = await t.mutation(api.provider.claimTicket, {
      provider: "github",
      ottHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(claimed).toBeNull();
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(1);
    });
  });

  test("claimTicket deletes but does not return an expired ticket", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      provider: "google",
      stateHash: "0".repeat(64),
      ottHash: "a".repeat(64),
      payload: "encrypted-payload",
    });
    vi.advanceTimersByTime(3 * 60 * 1000);
    const claimed = await t.mutation(api.provider.claimTicket, {
      provider: "google",
      ottHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(claimed).toBeNull();
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(0);
    });
  });

  test("ticket payload encryption round-trips only with the right token", async () => {
    const token = generateRandomToken();
    const payload = JSON.stringify({ claims: { sub: "user-123" } });
    const encrypted = await encryptWithToken(token, payload);
    expect(encrypted).not.toContain("user-123");
    expect(await decryptWithToken(token, encrypted)).toBe(payload);
    await expect(
      decryptWithToken(generateRandomToken(), encrypted),
    ).rejects.toThrow();
  });
});
