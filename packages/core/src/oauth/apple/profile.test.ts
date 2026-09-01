import { describe, expect, test } from "vitest";
import { normalizeAppleProfile } from "./index.ts";
import type { OidcClaims } from "../shared/redemption.ts";

/** Apple's id_token claims for a signed-in user, overridable per test. */
function claims(overrides: Record<string, unknown> = {}): OidcClaims {
  return {
    sub: "001234.abcdef.0123",
    email: "ada@privaterelay.appleid.com",
    email_verified: true,
    ...overrides,
  };
}

describe("normalizeAppleProfile", () => {
  test("a first sign-in gets the name from the callback", () => {
    expect(
      normalizeAppleProfile(claims(), {
        name: { firstName: "Ada", lastName: "Lovelace" },
      }),
    ).toEqual({
      id: "001234.abcdef.0123",
      email: "ada@privaterelay.appleid.com",
      emailVerified: true,
      name: "Ada Lovelace",
    });
  });

  test("a return visit has no name", () => {
    expect(normalizeAppleProfile(claims(), undefined).name).toBeUndefined();
  });

  test.each([
    ["a first name alone", { firstName: "Ada" }, "Ada"],
    ["a last name alone", { lastName: "Lovelace" }, "Lovelace"],
  ])("%s becomes the whole name", (_case, name, expected) => {
    expect(normalizeAppleProfile(claims(), { name }).name).toBe(expected);
  });

  test("a user with no name parts leaves the name off", () => {
    expect(normalizeAppleProfile(claims(), { name: {} }).name).toBeUndefined();
  });

  test.each([
    ["the boolean true", true, true],
    ['the string "true"', "true", true],
    ["the boolean false", false, false],
    ['the string "false"', "false", false],
    ["a missing claim", undefined, false],
  ])("email_verified as %s maps to %s", (_case, value, expected) => {
    const profile = normalizeAppleProfile(
      claims({ email_verified: value }),
      undefined,
    );
    expect(profile.emailVerified).toBe(expected);
  });

  test("an account that shares no email leaves it off", () => {
    const profile = normalizeAppleProfile(
      claims({ email: undefined }),
      undefined,
    );
    expect(profile.email).toBeUndefined();
    expect(profile.id).toBe("001234.abcdef.0123");
  });
});
