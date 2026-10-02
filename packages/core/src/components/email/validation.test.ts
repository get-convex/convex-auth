import { describe, expect, test } from "vitest";
import {
  normalizeEmail,
  validateEmailFormat,
  type VerbatimEmail,
} from "./validation.ts";

describe("validateEmailFormat", () => {
  test("accepts a plain address", () => {
    expect(validateEmailFormat("alice@example.com")).toEqual({
      success: true,
      email: "alice@example.com",
    });
  });

  test.each([
    ["no at sign", "alice.example.com"],
    ["empty local part", "@example.com"],
    ["no domain dot", "alice@example"],
    ["whitespace", "alice @example.com"],
    ["two at signs", "a@b@example.com"],
    ["too long", "a".repeat(250) + "@example.com"],
  ])("rejects %s", (_name, email) => {
    expect(validateEmailFormat(email)).toEqual({
      success: false,
      userError: { error: "INVALID_EMAIL" },
    });
  });
});

describe("normalizeEmail", () => {
  test("lowercases and applies NFC", () => {
    expect(normalizeEmail("Alice@Example.COM" as VerbatimEmail)).toBe(
      "alice@example.com",
    );
    // "e" + combining acute accent (U+0301) normalizes to the composed form.
    expect(normalizeEmail("he\u0301lene@example.com" as VerbatimEmail)).toBe(
      "h\u00e9lene@example.com",
    );
  });
});
