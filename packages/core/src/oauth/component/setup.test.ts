import { describe, expect, test } from "vitest";
import type { ProviderHelpers } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProviderOptions,
} from "./setup";

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
 * Run the provider's setup with the given options merged over a valid base.
 * Validation runs before the helpers or component mount are touched, so
 * fakes suffice.
 */
function setup(
  options: Partial<OauthProviderOptions> = {},
  catalog: OauthCatalog = CATALOG,
) {
  return setupOauth("acme", catalog, {} as ProviderHelpers, {
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

  test("an openid catalog scope without a catalog issuer is rejected", () => {
    expect(() => setup({}, { ...CATALOG, scopes: ["openid"] })).toThrow(
      /sets no issuer/,
    );
  });

  test("a scopes override that adds openid without an issuer is rejected", () => {
    expect(() => setup({ scopes: ["openid"] })).toThrow(/sets no issuer/);
  });

  test.each(["state", "redirect_uri", "code_challenge"])(
    "extraAuthorizationParams protocol param %s is rejected",
    (param) => {
      expect(() =>
        setup({ extraAuthorizationParams: { [param]: "value" } }),
      ).toThrow(/must not set protocol param/);
    },
  );

  test("benign extraAuthorizationParams are accepted", () => {
    expect(() =>
      setup({ extraAuthorizationParams: { access_type: "offline" } }),
    ).not.toThrow();
  });
});
