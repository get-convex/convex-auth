/*
 * Vendored from @oslojs/binary v1.0.0 (https://github.com/oslo-project/binary,
 * commit 9186bf7), Copyright (c) 2024 pilcrowOnPaper, MIT license (see LICENSE
 * in this directory). Trimmed to the parts this package uses; see README.md.
 */

export function compareBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < b.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export class DynamicBuffer {
  private value: Uint8Array;
  public capacity: number;

  public length = 0;

  constructor(capacity: number) {
    this.value = new Uint8Array(capacity);
    this.capacity = capacity;
  }

  public write(bytes: Uint8Array): void {
    if (this.length + bytes.byteLength <= this.capacity) {
      this.value.set(bytes, this.length);
      this.length += bytes.byteLength;
      return;
    }
    while (this.length + bytes.byteLength > this.capacity) {
      if (this.capacity === 0) {
        this.capacity = 1;
      } else {
        this.capacity = this.capacity * 2;
      }
    }
    const newValue = new Uint8Array(this.capacity);
    newValue.set(this.value.subarray(0, this.length));
    newValue.set(bytes, this.length);
    this.value = newValue;
    this.length += bytes.byteLength;
  }

  public writeByte(byte: number): void {
    if (this.length + 1 <= this.capacity) {
      this.value[this.length] = byte;
      this.length++;
      return;
    }
    if (this.capacity === 0) {
      this.capacity = 1;
    } else {
      this.capacity = this.capacity * 2;
    }
    const newValue = new Uint8Array(this.capacity);
    newValue.set(this.value.subarray(0, this.length));
    newValue[this.length] = byte;
    this.value = newValue;
    this.length++;
  }

  public readInto(target: Uint8Array): void {
    if (target.byteLength < this.length) {
      throw new TypeError("Not enough space");
    }
    target.set(this.value.subarray(0, this.length));
  }

  public bytes(): Uint8Array {
    return this.value.slice(0, this.length);
  }

  public clear(): void {
    this.length = 0;
  }
}

export function bigIntBytes(value: bigint): Uint8Array {
  if (value < 0n) {
    value = value * -1n;
  }
  let byteLength = 1;
  while (value > 2n ** BigInt(byteLength * 8) - 1n) {
    byteLength++;
  }
  const encoded = new Uint8Array(byteLength);
  for (let i = 0; i < encoded.byteLength; i++) {
    encoded[i] = Number(
      (value >> BigInt((encoded.byteLength - i - 1) * 8)) & 0xffn,
    );
  }
  return encoded;
}

export function bigIntFromBytes(bytes: Uint8Array): bigint {
  if (bytes.byteLength < 1) {
    throw new TypeError("Empty Uint8Array");
  }
  let decoded = 0n;
  for (let i = 0; i < bytes.byteLength; i++) {
    decoded += BigInt(bytes[i]) << BigInt((bytes.byteLength - 1 - i) * 8);
  }
  return decoded;
}

export function rotr32(x: number, n: number): number {
  return ((x << (32 - n)) | (x >>> n)) >>> 0;
}

class BigEndian {
  public uint16(data: Uint8Array, offset: number): number {
    if (data.byteLength < offset + 2) {
      throw new TypeError("Insufficient bytes");
    }
    return (data[offset] << 8) | data[offset + 1];
  }

  public uint32(data: Uint8Array, offset: number): number {
    if (data.byteLength < offset + 4) {
      throw new TypeError("Insufficient bytes");
    }
    let result = 0;
    for (let i = 0; i < 4; i++) {
      result |= data[offset + i] << (24 - i * 8);
    }
    return result;
  }

  public uint64(data: Uint8Array, offset: number): bigint {
    if (data.byteLength < offset + 8) {
      throw new TypeError("Insufficient bytes");
    }
    let result = 0n;
    for (let i = 0; i < 8; i++) {
      result |= BigInt(data[offset + i]) << BigInt(56 - i * 8);
    }
    return result;
  }

  public putUint32(target: Uint8Array, value: number, offset: number): void {
    if (target.length < offset + 4) {
      throw new TypeError("Not enough space");
    }
    if (value < 0 || value > 4294967295) {
      throw new TypeError("Invalid uint32 value");
    }
    for (let i = 0; i < 4; i++) {
      target[offset + i] = (value >> ((3 - i) * 8)) & 0xff;
    }
  }

  public putUint64(target: Uint8Array, value: bigint, offset: number): void {
    if (target.length < offset + 8) {
      throw new TypeError("Not enough space");
    }
    if (value < 0 || value > 18446744073709551615n) {
      throw new TypeError("Invalid uint64 value");
    }
    for (let i = 0; i < 8; i++) {
      target[offset + i] = Number((value >> BigInt((7 - i) * 8)) & 0xffn);
    }
  }
}

export const bigEndian = new BigEndian();
