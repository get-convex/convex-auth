import { describe, expect, test } from "vitest";
import { normalizeGoogleProfile } from "./google";

describe("normalizeGoogleProfile", () => {
  test("maps validated id_token claims to the profile", () => {
    const profile = normalizeGoogleProfile(
      {
        sub: "123",
        email: "user@example.com",
        email_verified: true,
        name: "A User",
        picture: "https://example.com/avatar.png",
      },
      undefined,
    );
    expect(profile).toEqual({
      id: "123",
      email: "user@example.com",
      emailVerified: true,
      name: "A User",
      picture: "https://example.com/avatar.png",
    });
  });

  test("treats an absent email_verified claim as unverified", () => {
    const profile = normalizeGoogleProfile(
      { sub: "123", email: "user@example.com" },
      undefined,
    );
    expect(profile.emailVerified).toBe(false);
  });

  test("throws when there is no id_token to map", () => {
    expect(() => normalizeGoogleProfile(undefined, undefined)).toThrow(
      /no id_token/,
    );
  });
});
