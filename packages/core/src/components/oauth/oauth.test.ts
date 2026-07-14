import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  // Each per-IdP mount sees a CONVEX_SITE_URL prefixed with its http mount.
  process.env.CONVEX_SITE_URL = "https://test.convex.site/oauth/google";
  const t = convexTest(schema, modules);
  return t;
}

describe("oauth", () => {
  test("createAuthorizationRequest stores the request and returns the callback base URL", async () => {
    const t = setup();
    const result = await t.mutation(api.provider.createAuthorizationRequest, {
      provider: "google",
      stateHash: "0".repeat(64),
      redirectTo: "https://app.example.com/after",
    });
    expect(result).toBe("https://test.convex.site/oauth/google");
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(1);
      expect(requests[0].provider).toBe("google");
      expect(requests[0].stateHash).toBe("0".repeat(64));
      expect(requests[0].codeVerifier).toBeUndefined();
      expect(requests[0].expiresAt).toBeGreaterThan(Date.now());
    });
  });
});
