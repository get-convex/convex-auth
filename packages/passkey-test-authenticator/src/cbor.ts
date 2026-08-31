/** Just enough CBOR to build COSE keys and attestation objects. */

export type CBORValue =
  number | string | Uint8Array | Map<number | string, CBORValue>;

function cborHead(majorType: number, value: number): number[] {
  if (value < 24) {
    return [(majorType << 5) | value];
  }
  if (value < 0x100) {
    return [(majorType << 5) | 24, value];
  }
  if (value < 0x10000) {
    return [(majorType << 5) | 25, value >> 8, value & 0xff];
  }
  throw new Error("Value too large for the test CBOR encoder");
}

/** Encode a small CBOR value (enough for COSE keys and attestation objects). */
export function encodeCBOR(value: CBORValue): Uint8Array {
  const encode = (value: CBORValue): number[] => {
    if (typeof value === "number") {
      return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
    }
    if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value);
      return [...cborHead(3, bytes.length), ...bytes];
    }
    if (value instanceof Uint8Array) {
      return [...cborHead(2, value.length), ...value];
    }
    const out = cborHead(5, value.size);
    for (const [key, entry] of value) {
      out.push(...encode(key), ...encode(entry));
    }
    return out;
  };
  return new Uint8Array(encode(value));
}
