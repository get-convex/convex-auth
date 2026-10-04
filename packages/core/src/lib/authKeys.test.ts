import { beforeAll, describe, expect, test, vi, afterEach } from "vitest";
import {
  generateAuthKeys,
  validateAuthKeys,
  checkAuthConfiguration,
  type AuthKeys,
} from "./authKeys.ts";

let keys: AuthKeys;
beforeAll(async () => {
  keys = await generateAuthKeys();
});
afterEach(() => vi.unstubAllGlobals());

describe("auth signing configuration", () => {
  test("generates base64 PEM and a matching public JWKS", async () => {
    expect(atob(keys.authPrivateKey)).toContain("-----BEGIN PRIVATE KEY-----");
    expect(JSON.parse(keys.authJwks).keys[0]).not.toHaveProperty("d");
    await expect(validateAuthKeys(keys)).resolves.toHaveProperty("kid");
  });
  test.each([
    "raw PEM",
    "invalid base64",
    "encoded non-PEM",
    "invalid PKCS8",
    "invalid JWKS",
    "empty JWKS",
    "missing kid",
    "private JWKS",
    "wrong algorithm",
    "mismatched keys",
  ])("rejects %s with a safe configuration error", async (kind) => {
    const bad = { ...keys };
    if (kind === "raw PEM") bad.authPrivateKey = atob(keys.authPrivateKey);
    if (kind === "invalid base64") bad.authPrivateKey = "%%%";
    if (kind === "encoded non-PEM") bad.authPrivateKey = btoa("not a PEM");
    if (kind === "invalid PKCS8")
      bad.authPrivateKey = btoa(
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
      );
    if (kind === "invalid JWKS") bad.authJwks = "not json";
    if (kind === "empty JWKS") bad.authJwks = '{"keys":[]}';
    const jwks = JSON.parse(keys.authJwks);
    if (kind === "missing kid") {
      delete jwks.keys[0].kid;
      bad.authJwks = JSON.stringify(jwks);
    }
    if (kind === "private JWKS") {
      jwks.keys[0].d = "secret";
      bad.authJwks = JSON.stringify(jwks);
    }
    if (kind === "wrong algorithm") {
      jwks.keys[0].alg = "RS512";
      bad.authJwks = JSON.stringify(jwks);
    }
    if (kind === "mismatched keys")
      bad.authPrivateKey = (await generateAuthKeys()).authPrivateKey;
    try {
      await validateAuthKeys(bad);
      expect.fail("accepted invalid configuration");
    } catch (error) {
      expect(error).toHaveProperty("data.code", "AUTH_CONFIGURATION_ERROR");
      expect(String(error)).not.toContain(bad.authPrivateKey);
      if (["raw PEM", "invalid base64", "encoded non-PEM"].includes(kind))
        expect(error).toHaveProperty(
          "data.message",
          "AUTH_PRIVATE_KEY must contain base64-encoded PEM",
        );
    }
  });
  test("verifies against the served JWKS", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(keys.authJwks));
    vi.stubGlobal("fetch", fetch);
    await checkAuthConfiguration({
      ...keys,
      jwksUrl: "https://example.convex.site/auth/.well-known/jwks.json",
      issuer: "https://example.convex.site",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  test.each(["stale keys", "HTTP failure", "invalid JSON", "network failure"])(
    "rejects served JWKS %s",
    async (kind) => {
      const fetch = vi.fn();
      if (kind === "stale keys")
        fetch.mockResolvedValue(
          new Response((await generateAuthKeys()).authJwks),
        );
      if (kind === "HTTP failure")
        fetch.mockResolvedValue(new Response("", { status: 404 }));
      if (kind === "invalid JSON")
        fetch.mockResolvedValue(new Response("invalid"));
      if (kind === "network failure")
        fetch.mockRejectedValue(new Error("unreachable"));
      vi.stubGlobal("fetch", fetch);
      await expect(
        checkAuthConfiguration({
          ...keys,
          jwksUrl: "https://example.test/jwks",
          issuer: "https://example.test",
        }),
      ).rejects.toHaveProperty("data.code", "AUTH_CONFIGURATION_ERROR");
    },
  );
});
