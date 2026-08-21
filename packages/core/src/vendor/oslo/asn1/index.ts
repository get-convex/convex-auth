/*
 * Vendored from @oslojs/asn1 v1.0.0 (https://github.com/oslo-project/asn1,
 * commit 65a9bbd), Copyright (c) 2024 pilcrowOnPaper, MIT license (see LICENSE
 * in this directory). Trimmed to the ASN.1 types that appear in WebAuthn
 * signatures and keys; see README.md.
 */

import {
  bigIntBytes,
  bigIntFromBytes,
  compareBytes,
  DynamicBuffer,
} from "../binary/index.ts";

export function bigIntTwosComplementBytes(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array(1);
  }
  let byteLength = 1;
  if (value > 0n) {
    while (value > (1n << BigInt(byteLength * 8 - 1)) - 1n) {
      byteLength++;
    }
  } else {
    while (value < -1n << BigInt(byteLength * 8 - 1)) {
      byteLength++;
    }
  }
  const encoded = new Uint8Array(byteLength);
  for (let i = 0; i < encoded.byteLength; i++) {
    encoded[i] = Number(
      (value >> BigInt((encoded.byteLength - i - 1) * 8)) & 0xffn,
    );
  }
  return encoded;
}

export function bigIntFromTwosComplementBytes(bytes: Uint8Array): bigint {
  if (bytes.byteLength < 1) {
    throw new TypeError("Empty Uint8Array");
  }
  let decoded = 0n;
  for (let i = 0; i < bytes.byteLength; i++) {
    decoded += BigInt(bytes[i]) << BigInt((bytes.byteLength - 1 - i) * 8);
  }
  if (bytes[0] >> 7 === 0) {
    return decoded;
  }
  return decoded - (1n << BigInt(bytes.byteLength * 8));
}

export function variableLengthQuantityBytes(value: bigint): Uint8Array {
  let bitLength = 7;
  while (value > (1 << bitLength) - 1) {
    bitLength += 7;
  }
  const encoded = new Uint8Array(Math.ceil(bitLength / 8));
  for (let i = 0; i < encoded.byteLength; i++) {
    if (i === encoded.byteLength - 1) {
      encoded[i] = Number(
        (value >> BigInt((encoded.byteLength - i - 1) * 7)) & 0x7fn,
      );
    } else {
      encoded[i] =
        Number((value >> BigInt((encoded.byteLength - i - 1) * 7)) & 0x7fn) |
        0x80;
    }
  }
  return encoded;
}

export function variableLengthQuantityFromBytes(
  bytes: Uint8Array,
  maxBytes: number,
): [value: bigint, size: number] {
  let value = 0n;
  for (let i = 0; i < bytes.byteLength; i++) {
    value = (value << 7n) | BigInt(bytes[i] & 0x7f);
    if (bytes[i] >> 7 === 0) {
      return [value, i + 1];
    }
    if (i + 1 > maxBytes) {
      throw new Error("Data too large");
    }
  }
  throw new TypeError("Invalid variable length quantity");
}

export function parseASN1NoLeftoverBytes(data: Uint8Array): ASN1Value {
  const [decoded, size] = parseASN1(data);
  if (data.byteLength !== size) {
    throw new ASN1LeftoverBytesError(data.byteLength - size);
  }
  return decoded;
}

export function parseASN1(data: Uint8Array): [result: ASN1Value, size: number] {
  if (data.byteLength < 2) {
    throw new ASN1ParseError();
  }

  let asn1Class: ASN1Class;
  if (data[0] >> 6 === 0b00) {
    asn1Class = ASN1Class.Universal;
  } else if (data[0] >> 6 === 0b01) {
    asn1Class = ASN1Class.Application;
  } else if (data[0] >> 6 === 0b10) {
    asn1Class = ASN1Class.ContextSpecific;
  } else if (data[0] >> 6 === 0b11) {
    asn1Class = ASN1Class.Private;
  } else {
    // unreachable
    throw new ASN1ParseError();
  }

  let encodingForm: ASN1Form;
  if (((data[0] >> 5) & 0x01) === 0) {
    encodingForm = ASN1Form.Primitive;
  } else {
    encodingForm = ASN1Form.Constructed;
  }

  let offset = 0;

  let tag: number;
  if ((data[0] & 0x1f) < 31) {
    tag = data[0] & 0x1f;
    offset++;
  } else {
    offset++;

    let decodedTag: bigint;
    let tagSize: number;
    try {
      [decodedTag, tagSize] = variableLengthQuantityFromBytes(
        data.slice(offset),
        2,
      );
    } catch {
      throw new ASN1ParseError();
    }
    if (decodedTag > 16384n) {
      throw new ASN1ParseError();
    }
    tag = Number(decodedTag);
    offset += tagSize;
  }
  if (data.byteLength < offset) {
    throw new ASN1ParseError();
  }

  if (data[offset] === 0x80) {
    // indefinite form
    throw new ASN1ParseError();
  }

  // eslint-disable-next-line no-useless-assignment
  let contentLength = 0;
  if (data[offset] >> 7 === 0) {
    contentLength = data[offset] & 0x7f;
    offset++;
  } else {
    const contentLengthSize = data[offset] & 0x7f;
    offset++;
    if (contentLengthSize < 1 || data.byteLength < offset + contentLengthSize) {
      throw new ASN1ParseError();
    }
    const decodedContentLength = bigIntFromBytes(
      data.slice(offset, offset + contentLengthSize),
    );
    offset += contentLengthSize;
    contentLength = Number(decodedContentLength);
  }
  if (data.length < offset + contentLength) {
    throw new ASN1ParseError();
  }

  const value = data.slice(offset, offset + contentLength);
  const result = new ASN1Value(asn1Class, encodingForm, tag, value);
  return [result, offset + contentLength];
}

export function encodeASN1(value: ASN1Encodable): Uint8Array {
  const encodedContents = value.contents();

  let firstByte = 0x00;
  if (value.class === ASN1Class.Universal) {
    firstByte |= 0x00;
  } else if (value.class === ASN1Class.Application) {
    firstByte |= 0x40;
  } else if (value.class === ASN1Class.ContextSpecific) {
    firstByte |= 0x80;
  } else if (value.class === ASN1Class.Private) {
    firstByte |= 0xc0;
  }

  if (value.form === ASN1Form.Primitive) {
    firstByte |= 0x00;
  } else if (value.form === ASN1Form.Constructed) {
    firstByte |= 0x20;
  }

  const buffer = new DynamicBuffer(1);

  if (value.tag < 0x1f) {
    firstByte |= value.tag;
    buffer.writeByte(firstByte);
  } else {
    firstByte |= 0x1f;
    buffer.writeByte(firstByte);
    const encodedTagNumber = variableLengthQuantityBytes(BigInt(value.tag));
    buffer.write(encodedTagNumber);
  }

  if (encodedContents.byteLength < 128) {
    buffer.writeByte(encodedContents.byteLength);
  } else {
    const encodedContentsLength = bigIntBytes(
      BigInt(encodedContents.byteLength),
    );
    if (encodedContentsLength.byteLength > 126) {
      throw new ASN1EncodeError();
    }
    buffer.writeByte(encodedContentsLength.byteLength | 0x80);
    buffer.write(encodedContentsLength);
  }
  buffer.write(encodedContents);
  return buffer.bytes();
}

export interface ASN1Encodable {
  class: ASN1Class;
  form: ASN1Form;
  tag: number;

  contents(): Uint8Array;
}

export class ASN1Value implements ASN1Encodable {
  public class: ASN1Class;
  public form: ASN1Form;
  public tag: number;
  private _contents: Uint8Array;

  constructor(
    asn1Class: ASN1Class,
    form: ASN1Form,
    tag: number,
    value: Uint8Array,
  ) {
    this.class = asn1Class;
    this.form = form;
    this.tag = tag;
    this._contents = value;
  }

  public universalType(): ASN1UniversalType {
    if (
      this.class === ASN1Class.Universal &&
      this.tag in ASN1_UNIVERSAL_TAG_MAP
    ) {
      return ASN1_UNIVERSAL_TAG_MAP[this.tag];
    }
    throw new ASN1DecodeError();
  }

  public contents(): Uint8Array {
    return this._contents;
  }

  public integer(): ASN1Integer {
    if (this.universalType() !== ASN1UniversalType.Integer) {
      throw new ASN1DecodeError();
    }
    if (this.form !== ASN1Form.Primitive) {
      throw new ASN1DecodeError();
    }
    if (this._contents.byteLength < 1) {
      throw new ASN1DecodeError();
    }
    return new ASN1Integer(bigIntFromTwosComplementBytes(this._contents));
  }

  public objectIdentifier(): ASN1ObjectIdentifier {
    if (this.universalType() !== ASN1UniversalType.ObjectIdentifier) {
      throw new ASN1DecodeError();
    }
    if (this.form !== ASN1Form.Primitive) {
      throw new ASN1DecodeError();
    }
    if (this._contents.byteLength < 1) {
      throw new ASN1DecodeError();
    }
    return new ASN1ObjectIdentifier(this._contents);
  }

  public octetString(): ASN1OctetString {
    if (this.universalType() !== ASN1UniversalType.OctetString) {
      throw new ASN1DecodeError();
    }
    if (this.form !== ASN1Form.Primitive) {
      throw new ASN1DecodeError();
    }
    return new ASN1OctetString(this._contents);
  }

  public sequence(): ASN1Sequence {
    if (this.universalType() !== ASN1UniversalType.Sequence) {
      throw new ASN1DecodeError();
    }
    if (this.form !== ASN1Form.Constructed) {
      throw new ASN1DecodeError();
    }
    const elements: ASN1Value[] = [];
    let readBytes = 0;
    while (readBytes !== this._contents.byteLength) {
      const [parsedElement, parsedElementSize] = parseASN1(
        this._contents.slice(readBytes),
      );
      elements.push(parsedElement);
      readBytes += parsedElementSize;
    }
    return new ASN1Sequence(elements);
  }
}

export class ASN1Integer implements ASN1Encodable {
  public class = ASN1Class.Universal;
  public form = ASN1Form.Primitive;
  public tag = ASN1_UNIVERSAL_TAG.INTEGER;
  public value: bigint;

  constructor(value: bigint) {
    this.value = value;
  }

  public contents(): Uint8Array {
    return bigIntTwosComplementBytes(this.value);
  }
}

export class ASN1OctetString implements ASN1Encodable {
  public class = ASN1Class.Universal;
  public form = ASN1Form.Primitive;
  public tag = ASN1_UNIVERSAL_TAG.OCTET_STRING;
  public value: Uint8Array;

  constructor(value: Uint8Array) {
    this.value = value;
  }

  public contents(): Uint8Array {
    return this.value;
  }
}

export class ASN1Null implements ASN1Encodable {
  public class = ASN1Class.Universal;
  public form = ASN1Form.Primitive;
  public tag = ASN1_UNIVERSAL_TAG.NULL;

  public contents(): Uint8Array {
    return new Uint8Array(0);
  }
}

export class ASN1Sequence implements ASN1Encodable {
  public class = ASN1Class.Universal;
  public form = ASN1Form.Constructed;
  public tag = ASN1_UNIVERSAL_TAG.SEQUENCE;
  public elements: ASN1Value[];

  constructor(elements: ASN1Value[]) {
    this.elements = elements;
  }

  public contents(): Uint8Array {
    const buffer = new DynamicBuffer(0);
    for (const element of this.elements) {
      buffer.write(encodeASN1(element));
    }
    return buffer.bytes();
  }

  public at(index: number): ASN1Value {
    if (index < this.elements.length) {
      return this.elements[index];
    }
    throw new Error("Invalid index");
  }
}

export class ASN1EncodableSequence implements ASN1Encodable {
  public class = ASN1Class.Universal;
  public form = ASN1Form.Constructed;
  public tag = ASN1_UNIVERSAL_TAG.SEQUENCE;
  public elements: ASN1Encodable[];

  constructor(elements: ASN1Encodable[]) {
    this.elements = elements;
  }

  public contents(): Uint8Array {
    const buffer = new DynamicBuffer(0);
    for (const element of this.elements) {
      buffer.write(encodeASN1(element));
    }
    return buffer.bytes();
  }
}

export class ASN1ObjectIdentifier implements ASN1Encodable {
  public class = ASN1Class.Universal;
  public form = ASN1Form.Primitive;
  public tag = ASN1_UNIVERSAL_TAG.OBJECT_IDENTIFIER;
  public encoded: Uint8Array;

  constructor(encoded: Uint8Array) {
    this.encoded = encoded;
  }

  public contents(): Uint8Array {
    return this.encoded;
  }

  public is(objectIdentifier: string): boolean {
    return compareBytes(encodeObjectIdentifier(objectIdentifier), this.encoded);
  }
}

export function encodeObjectIdentifier(oid: string): Uint8Array {
  const parts = oid.split(".");
  const components: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const parsed = Number(parts[i]);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new TypeError("Invalid object identifier");
    }
    components[i] = parsed;
  }
  if (components.length < 2) {
    throw new TypeError("Invalid object identifier");
  }
  const firstSubidentifier = components[0] * 40 + components[1];
  const buffer = new DynamicBuffer(0);
  buffer.write(variableLengthQuantityBytes(BigInt(firstSubidentifier)));
  for (let i = 2; i < components.length; i++) {
    buffer.write(variableLengthQuantityBytes(BigInt(components[i])));
  }
  return buffer.bytes();
}

export enum ASN1UniversalType {
  Boolean = 0,
  Integer,
  BitString,
  OctetString,
  Null,
  ObjectIdentifier,
  ObjectDescriptor,
  External,
  Real,
  Enumerated,
  EmbeddedPDV,
  UTF8String,
  RelativeObjectIdentifier,
  Time,
  Sequence,
  Set,
  NumericString,
  PrintableString,
  TeletexString,
  VideotextString,
  IA5String,
  UTCTime,
  GeneralizedTime,
  GraphicString,
  VisibleString,
  GeneralString,
  UniversalString,
  CharacterString,
  BMPString,
}

export enum ASN1Class {
  Universal = 0,
  Application,
  ContextSpecific,
  Private,
}

export enum ASN1Form {
  Primitive = 0,
  Constructed,
}

export const ASN1_UNIVERSAL_TAG = {
  BOOLEAN: 1,
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  NULL: 5,
  OBJECT_IDENTIFIER: 6,
  OBJECT_DESCRIPTOR: 7,
  EXTERNAL: 8,
  REAL: 9,
  ENUMERATED: 10,
  EMBEDDED_PDV: 11,
  UTF8_STRING: 12,
  RELATIVE_OBJECT_IDENTIFIER: 13,
  TIME: 14,
  SEQUENCE: 16,
  SET: 17,
  NUMERIC_STRING: 18,
  PRINTABLE_STRING: 19,
  TELETEX_STRING: 20,
  VIDEOTEX_STRING: 21,
  IA5_STRING: 22,
  UTC_TIME: 23,
  GENERALIZED_TIME: 24,
  GRAPHIC_STRING: 25,
  VISIBLE_STRING: 26,
  GENERAL_STRING: 27,
  UNIVERSAL_STRING: 28,
  CHARACTER_STRING: 29,
  BMP_STRING: 30,
} as const;

const ASN1_UNIVERSAL_TAG_MAP: Record<number, ASN1UniversalType> = {
  1: ASN1UniversalType.Boolean,
  2: ASN1UniversalType.Integer,
  3: ASN1UniversalType.BitString,
  4: ASN1UniversalType.OctetString,
  5: ASN1UniversalType.Null,
  6: ASN1UniversalType.ObjectIdentifier,
  7: ASN1UniversalType.ObjectDescriptor,
  8: ASN1UniversalType.External,
  9: ASN1UniversalType.Real,
  10: ASN1UniversalType.Enumerated,
  11: ASN1UniversalType.EmbeddedPDV,
  12: ASN1UniversalType.UTF8String,
  13: ASN1UniversalType.RelativeObjectIdentifier,
  14: ASN1UniversalType.Time,
  16: ASN1UniversalType.Sequence,
  17: ASN1UniversalType.Set,
  18: ASN1UniversalType.NumericString,
  19: ASN1UniversalType.PrintableString,
  20: ASN1UniversalType.TeletexString,
  21: ASN1UniversalType.VideotextString,
  22: ASN1UniversalType.IA5String,
  23: ASN1UniversalType.UTCTime,
  24: ASN1UniversalType.GeneralizedTime,
  25: ASN1UniversalType.GraphicString,
  26: ASN1UniversalType.VisibleString,
  27: ASN1UniversalType.GeneralString,
  28: ASN1UniversalType.UniversalString,
  29: ASN1UniversalType.CharacterString,
  30: ASN1UniversalType.BMPString,
};

export class ASN1ParseError extends Error {
  constructor() {
    super("Failed to parse ASN.1");
  }
}

export class ASN1DecodeError extends Error {
  constructor() {
    super("Failed to decode ASN.1");
  }
}

export class ASN1EncodeError extends Error {
  constructor() {
    super("Failed to encode ASN.1");
  }
}

export class ASN1LeftoverBytesError extends Error {
  constructor(count: number) {
    super(`ASN.1 leftover bytes: ${count}`);
  }
}
