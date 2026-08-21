import { describe, expect, test } from "vitest";
import { actionGeneric, mutationGeneric } from "convex/server";
import type { AuthCore } from "../../components/core/setup.js";
import type { ComponentApi } from "./_generated/component.js";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProviderOptions,
} from "./setup.js";

/**
 * A minimal plain-OAuth catalog: no issuer or openid scope, no PKCE. Tests
 * override individual fields to exercise each validation rule.
 */
const CATALOG: OauthCatalog = {
  authorizationEndpoint: "https://provider.example/authorize",
  tokenEndpoint: "https://provider.example/token",
  scopes: [],
  pkce: false,
  profile: () => ({ id: "account-1" }),
};

/**
 * A core that hands back plain function builders. Nothing here calls the
 * built functions, so the injected `ctx.convexAuth` is never needed.
 */
const CORE = {
  bindProvider: () => ({
    authMutation: mutationGeneric,
    authAction: actionGeneric,
  }),
} as unknown as AuthCore;

/**
 * Run the provider's setup with the given options merged over a valid base.
 * Validation runs before the core or the component are touched, so
 * fakes suffice.
 */
function setup(
  options: Partial<OauthProviderOptions> = {},
  catalog: OauthCatalog = CATALOG,
) {
  return setupOauth(CORE, "acme", catalog, {} as never, {
    component: {} as ComponentApi,
    allowedRedirectOrigins: ["https://app.example.com"],
    ...options,
  });
}

describe("setupOauth validation", () => {
  test("http(s) redirect origins are accepted", () => {
    const api = setup({
      allowedRedirectOrigins: [
        "https://app.example.com",
        "http://localhost:5173",
      ],
    });
    expect(api.startSignIn).toBeDefined();
    expect(api.completeSignIn).toBeDefined();
  });

  test.each([
    "ftp://app.example.com",
    "ws://app.example.com",
    "wss://app.example.com",
    "myapp://home",
    "not a url",
  ])("redirect origin %s is rejected", (origin) => {
    expect(() => setup({ allowedRedirectOrigins: [origin] })).toThrow(
      /not a valid http\(s\) origin/,
    );
  });

  test("a redirect origin with a trailing slash is accepted", () => {
    const api = setup({
      allowedRedirectOrigins: ["https://app.example.com/"],
    });
    expect(api.startSignIn).toBeDefined();
  });

  test.each([
    "https://app.example.com/admin",
    "https://app.example.com/?q=1",
    "https://app.example.com/#section",
  ])("redirect origin %s with extra URL parts is rejected", (origin) => {
    expect(() => setup({ allowedRedirectOrigins: [origin] })).toThrow(
      /must be a bare origin/,
    );
  });

  test("an openid catalog scope without a catalog issuer is rejected", () => {
    expect(() => setup({}, { ...CATALOG, scopes: ["openid"] })).toThrow(
      /sets no issuer/,
    );
  });
});
