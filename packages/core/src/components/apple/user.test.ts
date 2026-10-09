import { describe, expect, test } from "vitest";
import { sanitizeAppleUser } from "./user.ts";

/** The field as Apple documents it, minus whatever a test overrides. */
function userField(value: unknown): string {
  return JSON.stringify(value);
}

describe("sanitizeAppleUser", () => {
  test("a first authorization's name comes through", () => {
    const user = sanitizeAppleUser(
      userField({
        name: { firstName: "Ada", lastName: "Lovelace" },
        email: "ada@example.com",
      }),
    );
    expect(user).toEqual({ name: { firstName: "Ada", lastName: "Lovelace" } });
  });

  test("the email is dropped, since the id_token carries the trusted one", () => {
    const user = sanitizeAppleUser(
      userField({ name: { firstName: "Ada" }, email: "attacker@example.com" }),
    );
    expect(user).toEqual({ name: { firstName: "Ada", lastName: undefined } });
    expect(JSON.stringify(user)).not.toContain("example.com");
  });

  test("either name part alone is enough", () => {
    expect(
      sanitizeAppleUser(userField({ name: { lastName: "Lovelace" } })),
    ).toEqual({ name: { firstName: undefined, lastName: "Lovelace" } });
  });

  test("surrounding whitespace is trimmed", () => {
    expect(
      sanitizeAppleUser(userField({ name: { firstName: "  Ada  " } })),
    ).toEqual({ name: { firstName: "Ada", lastName: undefined } });
  });

  test("a name part past the length cap is dropped", () => {
    const user = sanitizeAppleUser(
      userField({ name: { firstName: "a".repeat(257), lastName: "Lovelace" } }),
    );
    expect(user).toEqual({
      name: { firstName: undefined, lastName: "Lovelace" },
    });
  });

  test("a name part at the length cap is kept", () => {
    const firstName = "a".repeat(256);
    expect(sanitizeAppleUser(userField({ name: { firstName } }))).toEqual({
      name: { firstName, lastName: undefined },
    });
  });

  test.each([
    ["a missing field", null],
    ["unparseable JSON", "{not json"],
    ["a JSON string", userField("Ada")],
    ["a JSON array", userField(["Ada"])],
    ["JSON null", userField(null)],
    ["no name key", userField({ email: "ada@example.com" })],
    ["a string name", userField({ name: "Ada Lovelace" })],
    ["a null name", userField({ name: null })],
    [
      "name parts that aren't strings",
      userField({ name: { firstName: 42, lastName: {} } }),
    ],
    [
      "empty name parts",
      userField({ name: { firstName: "", lastName: "  " } }),
    ],
  ])("%s produces no user", (_name, raw) => {
    expect(sanitizeAppleUser(raw)).toBeUndefined();
  });

  test("extra keys inside name are not carried through", () => {
    const user = sanitizeAppleUser(
      userField({ name: { firstName: "Ada", middleName: "X", isAdmin: true } }),
    );
    expect(user).toEqual({ name: { firstName: "Ada", lastName: undefined } });
  });
});
