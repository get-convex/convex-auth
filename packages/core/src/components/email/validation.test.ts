import { describe, expect, test } from "vitest";
import { normalizeEmail, validateEmailFormat } from "./validation.ts";

describe("validateEmailFormat", () => {
  test.each([
    ["a plain address", "alice@example.com"],
    ["a plus tag and a subdomain", "Alice.Doe+tag@mail.example.co.uk"],
    ["the special characters of RFC 5322", "a!#$%&'*/=?^_`{|}~-b@example.com"],
  ])("accepts %s", (_name, email) => {
    expect(validateEmailFormat(email)).toBeNull();
  });

  test.each([
    ["no at sign", "alice.example.com"],
    ["empty local part", "@example.com"],
    ["no domain dot", "alice@example"],
    ["whitespace", "alice @example.com"],
    ["two at signs", "a@b@example.com"],
    ["too long", "a".repeat(250) + "@example.com"],
    // Resend rejects these, and fails the whole batch with them.
    ["a non-ASCII local part", "j\u00f6hn@example.com"],
    ["a non-ASCII domain", "a@ex\u00e4mple.com"],
    ["an IPv4 literal", "a@[127.0.0.1]"],
    ["an IPv6 literal", "a@[IPv6:2001:db8::1]"],
    ["a control character", "a\u0007b@example.com"],
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
