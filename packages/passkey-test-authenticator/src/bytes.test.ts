/**
 * The byte plumbing replaces a vendored library, thus it gets a test of its
 * own. The ceremony builders are covered by the tests that drive them.
 */
import { expect, test } from "vitest";
import { decodeBase64url, encodeBase64url, toDERSignature } from "./bytes.ts";

/** An ECDSA P-256 signature is `r || s`, 32 bytes each. */
function p1363(r: Uint8Array, s: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

const filled = (byte: number) => new Uint8Array(32).fill(byte);

test("DER-encodes a signature whose halves need no change", () => {
  const der = toDERSignature(p1363(filled(0x11), filled(0x22)));
  expect([...der.slice(0, 4)]).toEqual([0x30, 0x44, 0x02, 0x20]);
  expect([...der.slice(4, 36)]).toEqual([...filled(0x11)]);
  expect([...der.slice(36, 38)]).toEqual([0x02, 0x20]);
  expect([...der.slice(38)]).toEqual([...filled(0x22)]);
});

test("prefixes a zero byte when the high bit of an integer is set", () => {
  const der = toDERSignature(p1363(filled(0x80), filled(0x22)));
  expect([...der.slice(0, 5)]).toEqual([0x30, 0x45, 0x02, 0x21, 0x00]);
  expect([...der.slice(5, 37)]).toEqual([...filled(0x80)]);
});

test("strips the leading zero bytes of an integer", () => {
  const r = new Uint8Array([...new Array(30).fill(0), 0x01, 0x02]);
  const der = toDERSignature(p1363(r, filled(0x22)));
  expect([...der.slice(0, 6)]).toEqual([0x30, 0x26, 0x02, 0x02, 0x01, 0x02]);
});

test("keeps one byte of an integer that is zero", () => {
  const der = toDERSignature(p1363(filled(0), filled(0x22)));
  expect([...der.slice(0, 5)]).toEqual([0x30, 0x25, 0x02, 0x01, 0x00]);
});

test("decodes what it encodes, with or without the padding", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  const base64url = encodeBase64url(bytes);
  expect(base64url).not.toContain("=");
  expect([...decodeBase64url(base64url)]).toEqual([...bytes]);
  expect([...decodeBase64url(`${base64url}==`)]).toEqual([...bytes]);
});

test("decodes the URL-safe alphabet", () => {
  // `0xfb 0xff 0xbf` is `+/+/` in base64 and `-_-_` in base64url.
  expect([...decodeBase64url("-_-_")]).toEqual([0xfb, 0xff, 0xbf]);
});
