import { describe, expect, test } from "vitest";
import type { ComponentApi } from "./_generated/component.ts";
import { fakeCallbacks, fakeCore } from "../shared/componentContract.test.ts";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProviderOptions,
} from "./setup.ts";

/**
 * A minimal plain-OAuth catalog: no issuer and no openid scope. Tests
 * override individual fields to exercise each validation rule.
 */
const minimalCatalog: OauthCatalog = {
  authorizationEndpoint: "https://provider.example/authorize",
  tokenEndpoint: "https://provider.example/token",
  scopes: [],
  profile: () => ({ id: "account-1" }),
};

/**
 * Run the provider's setup with the given options merged over a valid base.
 * Validation runs before the core or the component are touched, so
 * fakes suffice.
 */
function setup(
  options: Partial<OauthProviderOptions> = {},
  catalog: OauthCatalog = minimalCatalog,
) {
  return setupOauth(fakeCore, "acme", catalog, fakeCallbacks, {
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
    expect(() => setup({}, { ...minimalCatalog, scopes: ["openid"] })).toThrow(
      /sets no issuer/,
    );
  });
});
