// Ported from @oslojs/binary (https://github.com/oslo-project/binary),
// MIT license. See README.md in this directory.
import { describe, expect, test } from "vitest";
import {
  bigIntBytes,
  bigIntFromBytes,
  compareBytes,
  DynamicBuffer,
  rotr32,
} from "./index";

test("bigIntBytes()", () => {
  expect(bigIntBytes(1n)).toStrictEqual(new Uint8Array([0x01]));
  expect(bigIntBytes(255n)).toStrictEqual(new Uint8Array([0xff]));
  expect(bigIntBytes(256n)).toStrictEqual(new Uint8Array([0x01, 0x00]));
  expect(bigIntBytes(-256n)).toStrictEqual(new Uint8Array([0x01, 0x00]));
  expect(
    bigIntBytes(
      5476057457410545405175640567415649081748931656501235026509713265394n,
    ),
  ).toStrictEqual(
    new Uint8Array([
      0x33, 0xff, 0x8e, 0xec, 0x07, 0x9c, 0x46, 0x65, 0x7a, 0x20, 0xb5, 0xd4,
      0xb4, 0x7d, 0xf6, 0xb0, 0x59, 0xca, 0x46, 0xb4, 0x4b, 0xfa, 0xae, 0x0d,
      0x3b, 0xf6, 0x52, 0xf2,
    ]),
  );
});

test("bigIntFromBytes()", () => {
  expect(bigIntFromBytes(new Uint8Array([0x01]))).toBe(1n);
  expect(bigIntFromBytes(new Uint8Array([0xff]))).toBe(255n);
  expect(bigIntFromBytes(new Uint8Array([0x01, 0x00]))).toBe(256n);
  expect(
    bigIntFromBytes(
      new Uint8Array([
        0x33, 0xff, 0x8e, 0xec, 0x07, 0x9c, 0x46, 0x65, 0x7a, 0x20, 0xb5, 0xd4,
        0xb4, 0x7d, 0xf6, 0xb0, 0x59, 0xca, 0x46, 0xb4, 0x4b, 0xfa, 0xae, 0x0d,
        0x3b, 0xf6, 0x52, 0xf2,
      ]),
    ),
  ).toBe(5476057457410545405175640567415649081748931656501235026509713265394n);
});

test("compareBytes()", () => {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  expect(compareBytes(randomBytes, randomBytes)).toBe(true);
  const anotherRandomBytes = new Uint8Array(32);
  crypto.getRandomValues(anotherRandomBytes);
  expect(compareBytes(randomBytes, anotherRandomBytes)).toBe(false);
  expect(compareBytes(new Uint8Array(0), new Uint8Array(1))).toBe(false);
});

test("rotr32()", () => {
  expect(rotr32(0b00000000000000000000000000001111, 2)).toBe(
    0b11000000000000000000000000000011,
  );
});

describe("DynamicBuffer", () => {
  test("DynamicBuffer.write()", () => {
    const buffer = new DynamicBuffer(0);
    buffer.write(new Uint8Array([0x01]));
    expect(buffer.bytes()).toStrictEqual(new Uint8Array([0x01]));
    buffer.write(new Uint8Array(100));
    expect(buffer.capacity).toStrictEqual(128);
    expect(buffer.bytes()).toStrictEqual(
      new Uint8Array([0x01, ...new Uint8Array(100)]),
    );
    buffer.write(new Uint8Array(27));
    expect(buffer.length).toStrictEqual(128);
    expect(buffer.capacity).toStrictEqual(128);
  });

  test("DynamicBuffer.writeByte()", () => {
    const buffer = new DynamicBuffer(0);
    buffer.writeByte(0x01);
    expect(buffer.bytes()).toStrictEqual(new Uint8Array([0x01]));
    buffer.writeByte(0x02);
    buffer.writeByte(0x03);
    buffer.writeByte(0x04);
    expect(buffer.capacity).toBe(4);
    expect(buffer.bytes()).toStrictEqual(
      new Uint8Array([0x01, 0x02, 0x03, 0x04]),
    );
  });
});
