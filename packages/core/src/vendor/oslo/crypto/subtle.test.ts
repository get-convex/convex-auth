// Tests for the vendored @oslojs/crypto subtle module (the original
// package did not ship tests for it).
import { expect, test } from "vitest";
import { constantTimeEqual } from "./subtle.js";

test("constantTimeEqual()", () => {
  expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  expect(
    constantTimeEqual(
      new Uint8Array([0x01, 0x02]),
      new Uint8Array([0x01, 0x02]),
    ),
  ).toBe(true);
  expect(
    constantTimeEqual(
      new Uint8Array([0x01, 0x02]),
      new Uint8Array([0x01, 0x03]),
    ),
  ).toBe(false);
  expect(
    constantTimeEqual(new Uint8Array([0x01, 0x02]), new Uint8Array([0x01])),
  ).toBe(false);
  const random = crypto.getRandomValues(new Uint8Array(32));
  expect(constantTimeEqual(random, random.slice())).toBe(true);
});
