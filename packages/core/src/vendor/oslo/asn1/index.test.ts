// Ported from @oslojs/asn1 (https://github.com/oslo-project/asn1),
// MIT license. See README.md in this directory. Trimmed to the ASN.1
// types kept in asn1.ts.
import { describe, expect, test } from "vitest";
import {
  ASN1Class,
  ASN1EncodableSequence,
  ASN1Form,
  ASN1Integer,
  ASN1Null,
  ASN1ObjectIdentifier,
  ASN1OctetString,
  ASN1Sequence,
  ASN1Value,
  bigIntFromTwosComplementBytes,
  bigIntTwosComplementBytes,
  encodeASN1,
  encodeObjectIdentifier,
  parseASN1,
  variableLengthQuantityBytes,
  variableLengthQuantityFromBytes,
} from "./index.js";

test("bigIntTwosComplementBytes()", () => {
  expect(bigIntTwosComplementBytes(0n)).toStrictEqual(new Uint8Array([0x00]));

  expect(bigIntTwosComplementBytes(1n)).toStrictEqual(new Uint8Array([0x01]));
  expect(bigIntTwosComplementBytes(127n)).toStrictEqual(new Uint8Array([0x7f]));
  expect(bigIntTwosComplementBytes(128n)).toStrictEqual(
    new Uint8Array([0x00, 0x80]),
  );
  expect(
    bigIntTwosComplementBytes(
      5476057457410545405175640567415649081748931656501235026509713265394n,
    ),
  ).toStrictEqual(
    new Uint8Array([
      0x33, 0xff, 0x8e, 0xec, 0x07, 0x9c, 0x46, 0x65, 0x7a, 0x20, 0xb5, 0xd4,
      0xb4, 0x7d, 0xf6, 0xb0, 0x59, 0xca, 0x46, 0xb4, 0x4b, 0xfa, 0xae, 0x0d,
      0x3b, 0xf6, 0x52, 0xf2,
    ]),
  );

  expect(bigIntTwosComplementBytes(-1n)).toStrictEqual(new Uint8Array([0xff]));
  expect(bigIntTwosComplementBytes(-128n)).toStrictEqual(
    new Uint8Array([0x80]),
  );
  expect(bigIntTwosComplementBytes(-129n)).toStrictEqual(
    new Uint8Array([0xff, 0x7f]),
  );
  expect(
    bigIntTwosComplementBytes(
      -5476057457410545405175640567415649081748931656501235026509713265394n,
    ),
  ).toStrictEqual(
    new Uint8Array([
      0xcc, 0x00, 0x71, 0x13, 0xf8, 0x63, 0xb9, 0x9a, 0x85, 0xdf, 0x4a, 0x2b,
      0x4b, 0x82, 0x09, 0x4f, 0xa6, 0x35, 0xb9, 0x4b, 0xb4, 0x05, 0x51, 0xf2,
      0xc4, 0x09, 0xad, 0x0e,
    ]),
  );
});

test("bigIntFromTwosComplementBytes()", () => {
  expect(bigIntFromTwosComplementBytes(new Uint8Array([0x00]))).toBe(0n);

  expect(bigIntFromTwosComplementBytes(new Uint8Array([0x01]))).toBe(1n);
  expect(bigIntFromTwosComplementBytes(new Uint8Array([0x7f]))).toBe(127n);
  expect(bigIntFromTwosComplementBytes(new Uint8Array([0x00, 0x80]))).toBe(
    128n,
  );
  expect(
    bigIntFromTwosComplementBytes(
      new Uint8Array([
        0x33, 0xff, 0x8e, 0xec, 0x07, 0x9c, 0x46, 0x65, 0x7a, 0x20, 0xb5, 0xd4,
        0xb4, 0x7d, 0xf6, 0xb0, 0x59, 0xca, 0x46, 0xb4, 0x4b, 0xfa, 0xae, 0x0d,
        0x3b, 0xf6, 0x52, 0xf2,
      ]),
    ),
  ).toBe(5476057457410545405175640567415649081748931656501235026509713265394n);

  expect(bigIntFromTwosComplementBytes(new Uint8Array([0xff]))).toBe(-1n);
  expect(bigIntFromTwosComplementBytes(new Uint8Array([0x80]))).toBe(-128n);
  expect(bigIntFromTwosComplementBytes(new Uint8Array([0xff, 0x7f]))).toBe(
    -129n,
  );
  expect(
    bigIntFromTwosComplementBytes(
      new Uint8Array([
        0xcc, 0x00, 0x71, 0x13, 0xf8, 0x63, 0xb9, 0x9a, 0x85, 0xdf, 0x4a, 0x2b,
        0x4b, 0x82, 0x09, 0x4f, 0xa6, 0x35, 0xb9, 0x4b, 0xb4, 0x05, 0x51, 0xf2,
        0xc4, 0x09, 0xad, 0x0e,
      ]),
    ),
  ).toBe(-5476057457410545405175640567415649081748931656501235026509713265394n);
});

test("variableLengthQuantityBytes()", () => {
  expect(variableLengthQuantityBytes(1n)).toStrictEqual(new Uint8Array([0x01]));
  expect(variableLengthQuantityBytes(0x7fn)).toStrictEqual(
    new Uint8Array([0x7f]),
  );
  expect(variableLengthQuantityBytes(0xffn)).toStrictEqual(
    new Uint8Array([0x81, 0x7f]),
  );
  expect(variableLengthQuantityBytes(0xffffn)).toStrictEqual(
    new Uint8Array([0x83, 0xff, 0x7f]),
  );
});

test("variableLengthQuantityFromBytes()", () => {
  expect(
    variableLengthQuantityFromBytes(new Uint8Array([0x01]), 10),
  ).toStrictEqual([1n, 1]);
  expect(
    variableLengthQuantityFromBytes(new Uint8Array([0x7f]), 10),
  ).toStrictEqual([0x7fn, 1]);
  expect(
    variableLengthQuantityFromBytes(new Uint8Array([0x81, 0x7f]), 10),
  ).toStrictEqual([0xffn, 2]);
  expect(
    variableLengthQuantityFromBytes(new Uint8Array([0x83, 0xff, 0x7f]), 10),
  ).toStrictEqual([0xffffn, 3]);
  expect(
    variableLengthQuantityFromBytes(
      new Uint8Array([0x83, 0xff, 0x7f, 0x00]),
      10,
    ),
  ).toStrictEqual([0xffffn, 3]);
  expect(() =>
    variableLengthQuantityFromBytes(new Uint8Array([0x83, 0xff]), 10),
  ).toThrowError();
});

test("parseASN1", () => {
  expect(parseASN1(new Uint8Array([0b00000000, 0x00]))).toStrictEqual([
    new ASN1Value(ASN1Class.Universal, ASN1Form.Primitive, 0, new Uint8Array()),
    2,
  ]);

  expect(parseASN1(new Uint8Array([0b01000000, 0x00]))).toStrictEqual([
    new ASN1Value(
      ASN1Class.Application,
      ASN1Form.Primitive,
      0,
      new Uint8Array(),
    ),
    2,
  ]);

  expect(parseASN1(new Uint8Array([0b10000000, 0x00]))).toStrictEqual([
    new ASN1Value(
      ASN1Class.ContextSpecific,
      ASN1Form.Primitive,
      0,
      new Uint8Array(),
    ),
    2,
  ]);

  expect(parseASN1(new Uint8Array([0b11000000, 0x00]))).toStrictEqual([
    new ASN1Value(ASN1Class.Private, ASN1Form.Primitive, 0, new Uint8Array()),
    2,
  ]);

  expect(parseASN1(new Uint8Array([0b00100000, 0x00]))).toStrictEqual([
    new ASN1Value(
      ASN1Class.Universal,
      ASN1Form.Constructed,
      0,
      new Uint8Array(),
    ),
    2,
  ]);

  expect(parseASN1(new Uint8Array([0x01, 0x00]))).toStrictEqual([
    new ASN1Value(ASN1Class.Universal, ASN1Form.Primitive, 1, new Uint8Array()),
    2,
  ]);

  expect(parseASN1(new Uint8Array([0x1e, 0x00]))).toStrictEqual([
    new ASN1Value(
      ASN1Class.Universal,
      ASN1Form.Primitive,
      30,
      new Uint8Array(),
    ),
    2,
  ]);

  expect(parseASN1(new Uint8Array([0x1f, 0xc0, 0x00, 0x00]))).toStrictEqual([
    new ASN1Value(
      ASN1Class.Universal,
      ASN1Form.Primitive,
      8192,
      new Uint8Array(),
    ),
    4,
  ]);

  expect(
    parseASN1(new Uint8Array([0x00, 0x7f, ...new Uint8Array(127)])),
  ).toStrictEqual([
    new ASN1Value(
      ASN1Class.Universal,
      ASN1Form.Primitive,
      0,
      new Uint8Array(127),
    ),
    129,
  ]);

  expect(
    parseASN1(new Uint8Array([0x00, 0x81, 0x80, ...new Uint8Array(128)])),
  ).toStrictEqual([
    new ASN1Value(
      ASN1Class.Universal,
      ASN1Form.Primitive,
      0,
      new Uint8Array(128),
    ),
    131,
  ]);

  expect(
    parseASN1(new Uint8Array([0x00, 0x82, 0x01, 0x00, ...new Uint8Array(256)])),
  ).toStrictEqual([
    new ASN1Value(
      ASN1Class.Universal,
      ASN1Form.Primitive,
      0,
      new Uint8Array(256),
    ),
    256 + 4,
  ]);
});

test("encodeObjectIdentifier()", () => {
  expect(encodeObjectIdentifier("2.100.3")).toStrictEqual(
    new Uint8Array([0x81, 0x34, 0x03]),
  );
  expect(encodeObjectIdentifier("1.2.840.10045.4.3.2")).toStrictEqual(
    new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
  );
});

test("encodeASN1", () => {
  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        0,
        new Uint8Array(),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0b00000000, 0x00]));

  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Application,
        ASN1Form.Primitive,
        0,
        new Uint8Array(),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0b01000000, 0x00]));

  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.ContextSpecific,
        ASN1Form.Primitive,
        0,
        new Uint8Array(),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0b10000000, 0x00]));

  expect(
    encodeASN1(
      new ASN1Value(ASN1Class.Private, ASN1Form.Primitive, 0, new Uint8Array()),
    ),
  ).toStrictEqual(new Uint8Array([0b11000000, 0x00]));

  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Constructed,
        0,
        new Uint8Array(),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0b00100000, 0x00]));

  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        1,
        new Uint8Array(),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0x01, 0x00]));

  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        30,
        new Uint8Array(),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0x1e, 0x00]));

  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        8192,
        new Uint8Array(),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0x1f, 0xc0, 0x00, 0x00]));
  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        0,
        new Uint8Array(127),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0x00, 0x7f, ...new Uint8Array(127)]));
  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        0,
        new Uint8Array(128),
      ),
    ),
  ).toStrictEqual(new Uint8Array([0x00, 0x81, 0x80, ...new Uint8Array(128)]));
  expect(
    encodeASN1(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        0,
        new Uint8Array(256),
      ),
    ),
  ).toStrictEqual(
    new Uint8Array([0x00, 0x82, 0x01, 0x00, ...new Uint8Array(256)]),
  );
});

describe("ASN1Value", () => {
  test("ASN1Value.integer()", () => {
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        2,
        new Uint8Array([0x00]),
      ).integer(),
    ).toStrictEqual(new ASN1Integer(0n));
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        2,
        new Uint8Array([0x01]),
      ).integer(),
    ).toStrictEqual(new ASN1Integer(1n));
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        2,
        new Uint8Array([0x00, 0x80]),
      ).integer(),
    ).toStrictEqual(new ASN1Integer(128n));
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        2,
        new Uint8Array([
          0x33, 0xff, 0x8e, 0xec, 0x07, 0x9c, 0x46, 0x65, 0x7a, 0x20, 0xb5,
          0xd4, 0xb4, 0x7d, 0xf6, 0xb0, 0x59, 0xca, 0x46, 0xb4, 0x4b, 0xfa,
          0xae, 0x0d, 0x3b, 0xf6, 0x52, 0xf2,
        ]),
      ).integer(),
    ).toStrictEqual(
      new ASN1Integer(
        5476057457410545405175640567415649081748931656501235026509713265394n,
      ),
    );
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        2,
        new Uint8Array([0xff]),
      ).integer(),
    ).toStrictEqual(new ASN1Integer(-1n));
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        2,
        new Uint8Array([0xff, 0x7f]),
      ).integer(),
    ).toStrictEqual(new ASN1Integer(-129n));
  });

  test("ASN1Value.octetString()", () => {
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        4,
        new Uint8Array([]),
      ).octetString(),
    ).toStrictEqual(new ASN1OctetString(new Uint8Array()));
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        4,
        new Uint8Array([
          0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        ]),
      ).octetString(),
    ).toStrictEqual(
      new ASN1OctetString(
        new Uint8Array([
          0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        ]),
      ),
    );
  });

  test("ASN1Value.objectIdentifier()", () => {
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Primitive,
        6,
        new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
      ).objectIdentifier(),
    ).toStrictEqual(
      new ASN1ObjectIdentifier(
        new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
      ),
    );
  });

  test("ASN1Value.sequence()", () => {
    expect(
      new ASN1Value(
        ASN1Class.Universal,
        ASN1Form.Constructed,
        16,
        new Uint8Array([0x01, 0x01, 0xff, 0x01, 0x01, 0x00, 0x01, 0x01, 0xff]),
      ).sequence(),
    ).toStrictEqual(
      new ASN1Sequence([
        new ASN1Value(
          ASN1Class.Universal,
          ASN1Form.Primitive,
          1,
          new Uint8Array([0xff]),
        ),
        new ASN1Value(
          ASN1Class.Universal,
          ASN1Form.Primitive,
          1,
          new Uint8Array([0x00]),
        ),
        new ASN1Value(
          ASN1Class.Universal,
          ASN1Form.Primitive,
          1,
          new Uint8Array([0xff]),
        ),
      ]),
    );
  });
});

describe("ASN1Integer", () => {
  test("ASN1Integer.contents()", () => {
    expect(new ASN1Integer(0n).contents()).toStrictEqual(
      new Uint8Array([0x00]),
    );
    expect(new ASN1Integer(1n).contents()).toStrictEqual(
      new Uint8Array([0x01]),
    );
    expect(new ASN1Integer(128n).contents()).toStrictEqual(
      new Uint8Array([0x00, 0x80]),
    );
    expect(
      new ASN1Integer(
        5476057457410545405175640567415649081748931656501235026509713265394n,
      ).contents(),
    ).toStrictEqual(
      new Uint8Array([
        0x33, 0xff, 0x8e, 0xec, 0x07, 0x9c, 0x46, 0x65, 0x7a, 0x20, 0xb5, 0xd4,
        0xb4, 0x7d, 0xf6, 0xb0, 0x59, 0xca, 0x46, 0xb4, 0x4b, 0xfa, 0xae, 0x0d,
        0x3b, 0xf6, 0x52, 0xf2,
      ]),
    );
    expect(new ASN1Integer(-1n).contents()).toStrictEqual(
      new Uint8Array([0xff]),
    );
    expect(new ASN1Integer(-129n).contents()).toStrictEqual(
      new Uint8Array([0xff, 0x7f]),
    );
  });
});

describe("ASN1OctetString", () => {
  test("ASN1OctetString.contents()", () => {
    expect(new ASN1OctetString(new Uint8Array()).contents()).toStrictEqual(
      new Uint8Array(),
    );
    expect(
      new ASN1OctetString(
        new Uint8Array([
          0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        ]),
      ).contents(),
    ).toStrictEqual(
      new Uint8Array([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
      ]),
    );
  });
});

describe("ASN1Null", () => {
  test("ASN1Null.contents()", () => {
    expect(new ASN1Null().contents()).toStrictEqual(new Uint8Array());
  });
});

describe("ASN1ObjectIdentifier", () => {
  test("ASN1ObjectIdentifier.contents()", () => {
    expect(
      new ASN1ObjectIdentifier(
        new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
      ).contents(),
    ).toStrictEqual(
      new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
    );
  });

  test("ASN1ObjectIdentifier.is()", () => {
    const oid = new ASN1ObjectIdentifier(
      new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
    );
    expect(oid.is("1.2.840.10045.4.3.2")).toBe(true);
    expect(oid.is("1.2.840.10045.4.3.3")).toBe(false);
  });
});

describe("ASN1EncodableSequence", () => {
  test("ASN1EncodableSequence.contents()", () => {
    // The original test used three ASN.1 booleans; booleans are trimmed
    // from the vendored code, so integers with the same encoded size are
    // used instead.
    expect(
      new ASN1EncodableSequence([
        new ASN1Integer(-1n),
        new ASN1Integer(0n),
        new ASN1Integer(-1n),
      ]).contents(),
    ).toStrictEqual(
      new Uint8Array([0x02, 0x01, 0xff, 0x02, 0x01, 0x00, 0x02, 0x01, 0xff]),
    );
  });
});
