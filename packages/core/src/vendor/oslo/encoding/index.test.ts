// Ported from @oslojs/encoding (https://github.com/oslo-project/encoding),
// MIT license. See README.md in this directory. The reference base64url
// encoder from the original tests is replaced with `btoa`.
import { expect, test } from "vitest";
import { decodeBase64urlIgnorePadding } from "./index.ts";

function encodeBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

test("decodeBase64urlIgnorePadding()", () => {
  expect(decodeBase64urlIgnorePadding("")).toStrictEqual(new Uint8Array());
  expect(decodeBase64urlIgnorePadding("BQYHCA")).toStrictEqual(
    new Uint8Array([0x05, 0x06, 0x07, 0x08]),
  );
  // with and without padding
  for (let i = 1; i <= 100; i++) {
    const bytes = new Uint8Array(i);
    crypto.getRandomValues(bytes);
    expect(decodeBase64urlIgnorePadding(encodeBase64url(bytes))).toStrictEqual(
      bytes,
    );
    expect(
      decodeBase64urlIgnorePadding(encodeBase64url(bytes).replaceAll("=", "")),
    ).toStrictEqual(bytes);
  }
  // includes padding but invalid padding count
  for (let i = 1; i <= 100; i++) {
    const bytes = new Uint8Array(i);
    crypto.getRandomValues(bytes);
    expect(
      decodeBase64urlIgnorePadding(encodeBase64url(bytes).replace("=", "")),
    ).toStrictEqual(bytes);
  }
});

test("decodeBase64urlIgnorePadding() throws on invalid input", () => {
  expect(() => decodeBase64urlIgnorePadding("qq+q")).toThrowError();
  expect(() => decodeBase64urlIgnorePadding("qq/q")).toThrowError();
  expect(() => decodeBase64urlIgnorePadding("qqp")).toThrowError();
  expect(() => decodeBase64urlIgnorePadding("q")).toThrowError();
});
