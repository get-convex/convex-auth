import { describe, expect, test } from "vitest";
import { parseProviderTokens } from "./callback.ts";

describe("parseProviderTokens", () => {
  test("reads every field of a full token response", () => {
    expect(
      parseProviderTokens(
        "access-1",
        {
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: "openid email",
          token_type: "Bearer",
          id_token: "not-for-the-app",
        },
        1000,
      ),
    ).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1000 + 3600 * 1000,
      scope: "openid email",
      tokenType: "Bearer",
    });
  });

  test("a minimal response yields the access token as a bearer token", () => {
    expect(parseProviderTokens("access-1", {}, 1000)).toEqual({
      accessToken: "access-1",
      tokenType: "Bearer",
    });
  });

  test("a string expires_in is read as seconds", () => {
    expect(
      parseProviderTokens("access-1", { expires_in: "60" }, 1000).expiresAt,
    ).toBe(61_000);
  });

  test("fields of the wrong type are left out", () => {
    expect(
      parseProviderTokens(
        "access-1",
        {
          refresh_token: 42,
          expires_in: "soon",
          scope: ["openid"],
          token_type: "",
        },
        1000,
      ),
    ).toEqual({ accessToken: "access-1", tokenType: "Bearer" });
  });
});
