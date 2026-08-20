/*
 * Vendored from @oslojs/cbor v1.0.0 (https://github.com/oslo-project/cbor,
 * commit 0ec853c), Copyright (c) 2024 pilcrowOnPaper, MIT license (see LICENSE
 * in this directory). Trimmed to decoding only; see README.md.
 */

import { bigEndian, DynamicBuffer } from "../binary/index.js";

export type CBORValue =
  | CBORPositiveInteger
  | CBORNegativeInteger
  | CBORByteString
  | CBORTextString
  | CBORArray
  | CBORMap
  | CBORFloat16
  | CBORFloat32
  | CBORFloat64
  | CBORTagged
  | CBORSimple
  | CBORBreak;

export class CBORPositiveInteger {
  public value: bigint;

  constructor(value: bigint) {
    if (value < 0) {
      throw new TypeError();
    }
    this.value = value;
  }

  public isNumber(): boolean {
    return BigInt(Number(this.value)) === this.value;
  }
}

export class CBORNegativeInteger {
  public value: bigint;

  constructor(value: bigint) {
    if (value > -1) {
      throw new TypeError();
    }
    this.value = value;
  }

  public isNumber(): boolean {
    return BigInt(Number(this.value)) === this.value;
  }
}

export class CBORByteString {
  public value: Uint8Array;

  constructor(value: Uint8Array) {
    this.value = value;
  }
}

export class CBORTextString {
  public value: Uint8Array;

  constructor(value: Uint8Array) {
    this.value = value;
  }

  public decodeText(): string {
    try {
      return new TextDecoder("utf-8", {
        fatal: true,
      }).decode(this.value);
    } catch {
      throw new CBORInvalidError();
    }
  }
}

export class CBORArray {
  public elements: CBORValue[];

  constructor(elements: CBORValue[]) {
    this.elements = elements;
  }
}

export class CBORMap {
  public entries: [CBORValue, CBORValue][];

  constructor(entries: [CBORValue, CBORValue][]) {
    this.entries = entries;
  }
}

export class CBORFloat16 {
  public value: Uint8Array;

  constructor(value: Uint8Array) {
    if (value.byteLength !== 2) {
      throw new TypeError();
    }
    this.value = value;
  }

  public toNumber(): number {
    return toFloat16(this.value);
  }
}

export class CBORFloat32 {
  public value: Uint8Array;

  constructor(value: Uint8Array) {
    if (value.byteLength !== 4) {
      throw new TypeError();
    }
    this.value = value;
  }

  public toNumber(): number {
    return toFloat32(this.value);
  }
}

export class CBORFloat64 {
  public value: Uint8Array;

  constructor(value: Uint8Array) {
    if (value.byteLength !== 8) {
      throw new TypeError();
    }
    this.value = value;
  }

  public toNumber(): number {
    return toFloat64(this.value);
  }
}

export class CBORTagged {
  public tagNumber: bigint;
  public value: CBORValue;

  constructor(tagNumber: bigint, value: CBORValue) {
    this.tagNumber = tagNumber;
    this.value = value;
  }
}

export class CBORSimple {
  public value: number;

  constructor(value: number) {
    this.value = value;
  }
}

export class CBORBreak {
  public value = null;
}

export class CBORNotWellFormedError extends Error {
  constructor() {
    super("CBOR is not well-formed");
  }
}

export class CBORLeftoverBytesError extends Error {
  constructor(count: number) {
    super(`Leftover bytes: ${count}`);
  }
}

export class CBORTooDeepError extends Error {
  constructor() {
    super("Exceeds maximum depth");
  }
}

export class CBORInvalidError extends Error {
  constructor() {
    super("Invalid CBOR");
  }
}

export function toFloat16(data: Uint8Array): number {
  if (data.byteLength !== 2) {
    throw new TypeError();
  }
  const sign = (-1) ** (data[0] >> 7);
  let fraction = 0;
  fraction += 2 ** -1 * ((data[0] >> 1) & 0x01);
  fraction += 2 ** -2 * (data[0] & 0x01);
  for (let i = 0; i < 8; i++) {
    if (((data[1] >> (7 - i)) & 0x01) === 1) {
      fraction += 2 ** -(3 + i);
    }
  }
  const exponent = (data[0] >> 2) & 0x1f;
  if (exponent === 0) {
    return sign * 2 ** -14 * fraction;
  }
  if (exponent === 0x1f && fraction === 0) {
    return sign * Infinity;
  }
  if (exponent === 0x1f && fraction !== 0) {
    return NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction);
}

export function toFloat32(data: Uint8Array): number {
  if (data.byteLength !== 4) {
    throw new TypeError();
  }

  const sign = (-1) ** (data[0] >> 7);
  const exponent = ((data[0] & 0x7f) << 1) + (data[1] >> 7);
  let fractionPart = data[1] & 0x7f;
  for (let i = 0; i < 3; i++) {
    fractionPart |= data[2 + i];
  }

  if (exponent === 0xff && fractionPart === 0) {
    return sign * Infinity;
  }
  if (exponent === 0xff && fractionPart !== 0) {
    return NaN;
  }

  let bias: number;
  let result: number;
  if (exponent === 0) {
    bias = 126;
    result = 0;
  } else {
    bias = 127;
    result = 2 ** (exponent - bias);
  }
  for (let i = 0; i < 7; i++) {
    if (((data[1] >> (6 - i)) & 0x01) === 1) {
      result += 2 ** (-1 - i + exponent - bias);
    }
  }
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 8; j++) {
      if (((data[2 + i] >> (7 - j)) & 0x01) === 1) {
        const position = 8 + i * 8 + j;
        result += 2 ** (exponent - bias - position);
      }
    }
  }
  return sign * result;
}

export function toFloat64(data: Uint8Array): number {
  if (data.byteLength !== 8) {
    throw new TypeError();
  }

  const sign = (-1) ** (data[0] >> 7);
  const exponent = ((data[0] & 0x7f) << 4) + (data[1] >> 4);
  let fractionPart = data[1] & 0x0f;
  for (let i = 0; i < 6; i++) {
    fractionPart |= data[2 + i];
  }

  if (exponent === 0x7ff && fractionPart === 0) {
    return sign * Infinity;
  }
  if (exponent === 0x7ff && fractionPart !== 0) {
    return NaN;
  }

  let bias: number;
  let result: number;
  if (exponent === 0) {
    bias = 1022;
    result = 0;
  } else {
    bias = 1023;
    result = 2 ** (exponent - bias);
  }
  for (let i = 0; i < 4; i++) {
    if (((data[1] >> (3 - i)) & 0x01) === 1) {
      result += 2 ** (-1 - i + exponent - bias);
    }
  }
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 8; j++) {
      if (((data[2 + i] >> (7 - j)) & 0x01) === 1) {
        const position = 5 + i * 8 + j;
        result += 2 ** (exponent - bias - position);
      }
    }
  }
  return sign * result;
}

export function decodeCBORToNativeValueNoLeftoverBytes(
  data: Uint8Array,
  maxDepth: number,
): unknown {
  const decoded = decodeCBORNoLeftoverBytes(data, maxDepth);
  return transformCBORValueToNative(decoded);
}

export function decodeCBORToNativeValue(
  data: Uint8Array,
  maxDepth: number,
): [value: unknown, size: number] {
  const [decoded, size] = decodeCBOR(data, maxDepth);
  return [transformCBORValueToNative(decoded), size];
}

export function decodeCBORNoLeftoverBytes(
  data: Uint8Array,
  maxDepth: number,
): CBORValue {
  const [result, size] = decodeCBOR(data, maxDepth);
  if (size !== data.byteLength) {
    throw new CBORLeftoverBytesError(data.byteLength - size);
  }
  return result;
}

export function decodeCBOR(
  data: Uint8Array,
  maxDepth: number,
): [data: CBORValue, size: number] {
  const [value, size] = decodeCBORIncludingBreaks(data, maxDepth, 0);
  if (value instanceof CBORBreak) {
    throw new CBORNotWellFormedError();
  }
  return [value, size];
}

function decodeCBORIncludingBreaks(
  data: Uint8Array,
  maxDepth: number,
  currentDepth: number,
): [data: CBORValue, size: number] {
  if (currentDepth > maxDepth) {
    throw new CBORTooDeepError();
  }
  if (data.byteLength < 1) {
    throw new CBORNotWellFormedError();
  }
  const majorType = data[0] >> 5;

  if (majorType === 0) {
    // Positive integer
    const additionalInformation = data[0] & 0x1f;
    if (additionalInformation < 24) {
      return [new CBORPositiveInteger(BigInt(additionalInformation)), 1];
    }
    const argumentSize = getArgumentSize(additionalInformation);
    const value = getVariableUint(data, argumentSize, 1);
    return [new CBORPositiveInteger(value), 1 + argumentSize];
  }

  if (majorType === 1) {
    // Negative Integer
    const additionalInformation = data[0] & 0x1f;
    if (additionalInformation < 24) {
      return [new CBORNegativeInteger(BigInt(-1 - additionalInformation)), 1];
    }
    const argumentSize = getArgumentSize(additionalInformation);
    const value = getVariableUint(data, argumentSize, 1);
    return [new CBORNegativeInteger(-1n - BigInt(value)), 1 + argumentSize];
  }

  if (majorType === 2) {
    // Byte string
    const additionalInformation = data[0] & 0x1f;

    if (additionalInformation === 31) {
      // Indefinite size
      let offset = 1;
      let size = offset;
      const buffer = new DynamicBuffer(0);
      while (true) {
        if (data.byteLength < offset + 1) {
          throw new CBORNotWellFormedError();
        }

        const innerMajorType = data[offset] >> 5;
        const innerAdditionalInformation = data[offset] & 0x1f;
        if (innerMajorType === 7 && innerAdditionalInformation === 31) {
          // Break
          size += 1;
          break;
        }
        if (innerMajorType !== 2) {
          throw new CBORNotWellFormedError();
        }

        let innerByteSize: number;
        let innerOffset: number;
        if (innerAdditionalInformation < 24) {
          innerByteSize = innerAdditionalInformation;
          innerOffset = 1;
        } else {
          const innerArgumentSize = getArgumentSize(innerAdditionalInformation);
          innerByteSize = Number(
            getVariableUint(data, innerArgumentSize, offset + 1),
          );
          innerOffset = 1 + innerArgumentSize;
        }
        if (data.byteLength < offset + innerByteSize) {
          throw new CBORNotWellFormedError();
        }
        buffer.write(
          data.subarray(
            offset + innerOffset,
            offset + innerOffset + innerByteSize,
          ),
        );
        size += innerOffset + innerByteSize;
        offset += innerOffset + innerByteSize;
      }
      return [new CBORByteString(buffer.bytes()), size];
    }

    let offset: number;
    let byteSize: number;
    if (additionalInformation < 24) {
      byteSize = additionalInformation;
      offset = 1;
    } else {
      const argumentSize = getArgumentSize(additionalInformation);
      byteSize = Number(getVariableUint(data, argumentSize, 1));
      offset = 1 + argumentSize;
    }
    if (data.byteLength < offset + byteSize) {
      throw new CBORNotWellFormedError();
    }
    const value = data.slice(offset, offset + byteSize);
    return [new CBORByteString(value), offset + byteSize];
  }

  if (majorType === 3) {
    // Text string
    const additionalInformation = data[0] & 0x1f;
    let offset: number;
    if (additionalInformation === 31) {
      // Indefinite size
      offset = 1;
      let size = offset;
      const buffer = new DynamicBuffer(0);
      while (true) {
        if (data.byteLength < offset + 1) {
          throw new CBORNotWellFormedError();
        }

        const innerMajorType = data[offset] >> 5;
        const innerAdditionalInformation = data[offset] & 0x1f;
        if (innerMajorType === 7 && innerAdditionalInformation === 31) {
          // Break
          // eslint-disable-next-line no-useless-assignment
          offset += 1;
          size += 1;
          break;
        }
        if (innerMajorType !== 3) {
          throw new CBORNotWellFormedError();
        }

        let innerByteSize: number;
        let innerOffset: number;
        if (innerAdditionalInformation < 24) {
          innerByteSize = innerAdditionalInformation;
          innerOffset = 1;
        } else {
          const innerArgumentSize = getArgumentSize(innerAdditionalInformation);
          innerByteSize = Number(
            getVariableUint(data, innerArgumentSize, offset + 1),
          );
          innerOffset = 1 + innerArgumentSize;
        }
        if (data.byteLength < offset + innerByteSize) {
          throw new CBORNotWellFormedError();
        }
        buffer.write(
          data.subarray(
            offset + innerOffset,
            offset + innerOffset + innerByteSize,
          ),
        );
        size += innerOffset + innerByteSize;
        offset += innerOffset + innerByteSize;
      }
      return [new CBORTextString(buffer.bytes()), size];
    }

    let byteSize: number;
    if (additionalInformation < 24) {
      byteSize = additionalInformation;
      offset = 1;
    } else {
      const argumentSize = getArgumentSize(additionalInformation);
      byteSize = Number(getVariableUint(data, argumentSize, 1));
      offset = 1 + argumentSize;
    }
    if (data.byteLength < offset + byteSize) {
      throw new CBORNotWellFormedError();
    }
    const value = data.slice(offset, offset + byteSize);
    return [new CBORTextString(value), offset + byteSize];
  }

  if (majorType === 4) {
    // Array
    const additionalInformation = data[0] & 0x1f;
    let offset = 1;
    if (additionalInformation === 31) {
      let size = offset;
      const elements: CBORValue[] = [];
      while (true) {
        const [element, elementByteSize] = decodeCBORIncludingBreaks(
          data.subarray(offset),
          maxDepth,
          currentDepth + 1,
        );
        size += elementByteSize;
        if (element instanceof CBORBreak) {
          break;
        }
        offset += elementByteSize;
        elements.push(element);
      }
      return [new CBORArray(elements), size];
    }

    let arraySize: number;
    if (additionalInformation < 24) {
      arraySize = additionalInformation;
    } else {
      const argumentSize = getArgumentSize(additionalInformation);
      arraySize = Number(getVariableUint(data, argumentSize, 1));
      offset += argumentSize;
    }

    const elements: CBORValue[] = new Array(arraySize);
    let size = offset;
    for (let i = 0; i < arraySize; i++) {
      const [element, elementByteSize] = decodeCBORIncludingBreaks(
        data.subarray(offset),
        maxDepth,
        currentDepth + 1,
      );
      if (element instanceof CBORBreak) {
        throw new CBORNotWellFormedError();
      }
      offset += elementByteSize;
      size += elementByteSize;
      elements[i] = element;
    }
    return [new CBORArray(elements), size];
  }

  if (majorType === 5) {
    // Map
    const additionalInformation = data[0] & 0x1f;
    let offset = 1;
    if (additionalInformation === 31) {
      let size = offset;
      const entries: [CBORValue, CBORValue][] = [];
      while (true) {
        const [entryKey, keyByteSize] = decodeCBORIncludingBreaks(
          data.subarray(offset),
          maxDepth,
          currentDepth + 1,
        );
        if (entryKey instanceof CBORBreak) {
          size += keyByteSize;
          break;
        }
        offset += keyByteSize;
        size += keyByteSize;

        const [entryValue, valueByteSize] = decodeCBORIncludingBreaks(
          data.subarray(offset),
          maxDepth,
          currentDepth + 1,
        );
        if (entryValue instanceof CBORBreak) {
          throw new CBORNotWellFormedError();
        }
        entries.push([entryKey, entryValue]);
        offset += valueByteSize;
        size += valueByteSize;
      }
      return [new CBORMap(entries), size];
    }

    let pairCount: number;
    if (additionalInformation < 24) {
      pairCount = additionalInformation;
    } else {
      const argumentSize = getArgumentSize(additionalInformation);
      pairCount = Number(getVariableUint(data, argumentSize, 1));
      offset += argumentSize;
    }
    if (pairCount > data.byteLength) {
      throw new CBORNotWellFormedError();
    }

    const value: [CBORValue, CBORValue][] = new Array(pairCount);
    let size = offset;
    for (let i = 0; i < pairCount; i++) {
      const [entryKey, keyByteSize] = decodeCBORIncludingBreaks(
        data.subarray(offset),
        maxDepth,
        currentDepth + 1,
      );
      if (entryKey instanceof CBORBreak) {
        throw new CBORNotWellFormedError();
      }
      offset += keyByteSize;
      size += keyByteSize;

      const [entryValue, valueByteSize] = decodeCBORIncludingBreaks(
        data.subarray(offset),
        maxDepth,
        currentDepth + 1,
      );
      if (entryValue instanceof CBORBreak) {
        throw new CBORNotWellFormedError();
      }
      value[i] = [entryKey, entryValue];
      offset += valueByteSize;
      size += valueByteSize;
    }
    return [new CBORMap(value), size];
  }

  if (majorType === 6) {
    // Tagged
    const additionalInformation = data[0] & 0x1f;
    let tagNumber: bigint;
    let headSize: number;
    if (additionalInformation < 24) {
      tagNumber = BigInt(additionalInformation);
      headSize = 1;
    } else {
      const argumentSize = getArgumentSize(additionalInformation);
      tagNumber = getVariableUint(data, argumentSize, 1);
      headSize = 1 + argumentSize;
    }
    const [value, valueSize] = decodeCBORIncludingBreaks(
      data.subarray(headSize),
      maxDepth,
      currentDepth + 1,
    );
    return [new CBORTagged(tagNumber, value), headSize + valueSize];
  }

  if (majorType === 7) {
    // Simple value, float, or break
    const additionalInformation = data[0] & 0x1f;
    if (additionalInformation < 24) {
      // Simple value
      return [new CBORSimple(additionalInformation), 1];
    }
    if (additionalInformation === 24) {
      // Simple value
      if (data.byteLength < 2) {
        throw new CBORNotWellFormedError();
      }
      if (data[1] < 24) {
        throw new CBORNotWellFormedError();
      }
      return [new CBORSimple(data[1]), 2];
    }
    if (additionalInformation === 25) {
      // Float16
      if (data.byteLength < 2) {
        throw new CBORNotWellFormedError();
      }
      return [new CBORFloat16(data.subarray(1, 3)), 3];
    }
    if (additionalInformation === 26) {
      // Float32
      if (data.byteLength < 4) {
        throw new CBORNotWellFormedError();
      }
      return [new CBORFloat32(data.subarray(1, 5)), 5];
    }
    if (additionalInformation === 27) {
      // Float64
      if (data.byteLength < 8) {
        throw new CBORNotWellFormedError();
      }
      return [new CBORFloat64(data.subarray(1, 9)), 9];
    }
    if (additionalInformation === 31) {
      return [new CBORBreak(), 1];
    }
    throw new CBORNotWellFormedError();
  }

  throw new CBORNotWellFormedError();
}

function getArgumentSize(additionalInformation: number): number {
  if (additionalInformation === 24) {
    return 1;
  } else if (additionalInformation === 25) {
    return 2;
  } else if (additionalInformation === 26) {
    return 4;
  } else if (additionalInformation === 27) {
    return 8;
  } else {
    throw new CBORNotWellFormedError();
  }
}

function getVariableUint(
  data: Uint8Array,
  size: number,
  offset: number,
): bigint {
  if (data.byteLength < size + offset) {
    throw new Error();
  }
  if (size === 1) {
    return BigInt(data[offset]);
  }
  if (size === 2) {
    return BigInt(bigEndian.uint16(data, offset));
  }
  if (size === 4) {
    return BigInt(bigEndian.uint32(data, offset));
  }
  if (size === 8) {
    return bigEndian.uint64(data, offset);
  }
  throw new TypeError("Invalid size");
}

export function transformCBORValueToNative(cbor: CBORValue): unknown {
  if (
    cbor instanceof CBORPositiveInteger ||
    cbor instanceof CBORNegativeInteger
  ) {
    if (cbor.isNumber()) {
      return Number(cbor.value);
    }
    return cbor.value;
  }
  if (cbor instanceof CBORTextString) {
    return cbor.decodeText();
  }
  if (cbor instanceof CBORByteString) {
    return cbor.value;
  }
  if (
    cbor instanceof CBORFloat16 ||
    cbor instanceof CBORFloat32 ||
    cbor instanceof CBORFloat64
  ) {
    return cbor.toNumber();
  }
  if (cbor instanceof CBORSimple) {
    if (cbor.value === 20) {
      return false;
    }
    if (cbor.value === 21) {
      return true;
    }
    if (cbor.value === 22) {
      return null;
    }
    if (cbor.value === 23) {
      return undefined;
    }
    throw new CBORInvalidError();
  }
  if (cbor instanceof CBORArray) {
    const result = new Array(cbor.elements.length);
    for (let i = 0; i < cbor.elements.length; i++) {
      result[i] = transformCBORValueToNative(cbor.elements[i]);
    }
    return result;
  }
  if (cbor instanceof CBORMap) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<any, any> = {};
    for (let i = 0; i < cbor.entries.length; i++) {
      const [entryKey, entryValue] = cbor.entries[i];
      let stringifiedKey: string;
      if (entryKey instanceof CBORTextString) {
        stringifiedKey = entryKey.decodeText();
      } else if (
        entryKey instanceof CBORPositiveInteger ||
        entryKey instanceof CBORNegativeInteger
      ) {
        stringifiedKey = entryKey.value.toString();
      } else if (
        entryKey instanceof CBORFloat16 ||
        entryKey instanceof CBORFloat32 ||
        entryKey instanceof CBORFloat64
      ) {
        const valueNumber = entryKey.toNumber();
        if (Number.isNaN(valueNumber)) {
          throw new CBORInvalidError();
        }
        stringifiedKey = valueNumber.toString();
      } else {
        throw new CBORInvalidError();
      }
      if (stringifiedKey === "__proto__") {
        throw new CBORInvalidError();
      }
      if (stringifiedKey in result) {
        throw new CBORInvalidError();
      }
      result[stringifiedKey] = transformCBORValueToNative(entryValue);
    }
    return result;
  }
  if (cbor instanceof CBORTagged) {
    return transformCBORValueToNative(cbor.value);
  }
  throw new CBORInvalidError();
}
