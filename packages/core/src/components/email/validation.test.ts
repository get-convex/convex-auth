import { describe, expect, test } from "vitest";
import { normalizeEmail, validateEmailFormat } from "./validation.ts";

describe("validateEmailFormat", () => {
  test("accepts a plain address", () => {
    expect(validateEmailFormat("alice@example.com")).toBeNull();
  });

  test.each([
    ["no at sign", "alice.example.com"],
    ["empty local part", "@example.com"],
    ["no domain dot", "alice@example"],
    ["whitespace", "alice @example.com"],
    ["two at signs", "a@b@example.com"],
    ["too long", "a".repeat(250) + "@example.com"],
  ])("rejects %s", (_name, email) => {
    expect(validateEmailFormat(email)).toEqual({ error: "INVALID_EMAIL" });
  });
});

describe("normalizeEmail", () => {
  test("lowercases and applies NFC", () => {
    expect(normalizeEmail("Alice@Example.COM")).toBe("alice@example.com");
    // "e" + combining acute accent (U+0301) normalizes to the composed form.
    expect(normalizeEmail("he\u0301lene@example.com")).toBe(
      "h\u00e9lene@example.com",
    );
  });
});
