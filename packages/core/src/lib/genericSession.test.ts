import { describe, expect, test } from "vitest";
import { sha256 } from "@oslojs/crypto/sha2";
import {
  buildSessionString,
  bytesToUint8Array,
  constantTimeEqual,
  generateSessionSecret,
  generateShortCode,
  hashSecret,
  normalizeShortCode,
  parseSessionString,
} from "./genericSession";

describe("generateSessionSecret", () => {
  test("returns a URL-safe base64url string with no padding", () => {
    const secret = generateSessionSecret();
    // 32 bytes → 43 unpadded base64url characters, drawn from the URL-safe set.
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret).not.toContain("=");
    expect(secret.length).toBe(43);
  });

  test("is different on each call", () => {
    const a = generateSessionSecret();
    const b = generateSessionSecret();
    expect(a).not.toBe(b);
  });
});

describe("generateShortCode", () => {
  test("has the requested length and uses only the unambiguous alphabet", () => {
    const code = generateShortCode();
    expect(code.length).toBe(8);
    // No ambiguous characters (I, O, 0, 1) and uppercase only.
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
  });

  test("honors a custom length", () => {
    expect(generateShortCode(12).length).toBe(12);
  });

  test("is different on each call", () => {
    // Not a strict guarantee, but a collision across two 40-bit codes is
    // astronomically unlikely.
    expect(generateShortCode()).not.toBe(generateShortCode());
  });
});

describe("normalizeShortCode", () => {
  test("trims and uppercases", () => {
    expect(normalizeShortCode("  abc123  ")).toBe("ABC123");
  });
});

describe("hashSecret", () => {
  test("matches a plain SHA-256 of the UTF-8 bytes", () => {
    const value = "correct horse";
    const expected = sha256(new TextEncoder().encode(value));
    expect(bytesToUint8Array(hashSecret(value))).toEqual(expected);
  });

  test("is deterministic and differs for different inputs", () => {
    expect(bytesToUint8Array(hashSecret("a"))).toEqual(
      bytesToUint8Array(hashSecret("a")),
    );
    expect(bytesToUint8Array(hashSecret("a"))).not.toEqual(
      bytesToUint8Array(hashSecret("b")),
    );
  });
});

describe("constantTimeEqual", () => {
  test("compares hashed secrets", () => {
    const secret = generateSessionSecret();
    const stored = bytesToUint8Array(hashSecret(secret));
    expect(
      constantTimeEqual(bytesToUint8Array(hashSecret(secret)), stored),
    ).toBe(true);
    expect(
      constantTimeEqual(
        bytesToUint8Array(hashSecret(generateSessionSecret())),
        stored,
      ),
    ).toBe(false);
  });
});

describe("buildSessionString / parseSessionString", () => {
  test("round-trips an id and secret", () => {
    const session = buildSessionString("abc123", "s3cr3t");
    expect(session).toBe("abc123.s3cr3t");
    expect(parseSessionString(session)).toEqual({
      id: "abc123",
      secret: "s3cr3t",
    });
  });

  test("splits on the first dot so a secret may contain dots", () => {
    const session = buildSessionString("id", "a.b.c");
    expect(parseSessionString(session)).toEqual({ id: "id", secret: "a.b.c" });
  });

  test("returns null for a malformed string", () => {
    expect(parseSessionString("no-separator")).toBeNull();
    expect(parseSessionString(".onlysecret")).toBeNull();
    expect(parseSessionString("onlyid.")).toBeNull();
  });
});
