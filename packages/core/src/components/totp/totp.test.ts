import { describe, expect, test } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUri,
  timingSafeEqual,
  totp,
  totpCounter,
} from "./totp.ts";

const ascii = (text: string) => new TextEncoder().encode(text);

describe("base32", () => {
  // The test vectors of RFC 4648, section 10, without padding.
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];

  test("encodes the RFC 4648 vectors", () => {
    for (const [input, encoded] of vectors) {
      expect(base32Encode(ascii(input)), input).toBe(encoded);
    }
  });

  test("decodes the RFC 4648 vectors", () => {
    for (const [input, encoded] of vectors) {
      expect(new TextDecoder().decode(base32Decode(encoded)), encoded).toBe(
        input,
      );
    }
  });

  test("decodes with padding, in lowercase and with spaces", () => {
    for (const text of ["MZXW6YTBOI======", "mzxw6ytboi", "MZXW 6YTB OI"]) {
      expect(new TextDecoder().decode(base32Decode(text)), text).toBe("foobar");
    }
  });

  test("rejects a character outside the alphabet", () => {
    expect(() => base32Decode("MZXW1")).toThrow(/Invalid base32 character/);
  });

  test("rejects a length that no byte sequence encodes to", () => {
    for (const text of ["M", "MZX", "MZXW6Y", "MZXW6YTBM"]) {
      expect(() => base32Decode(text), text).toThrow(/Invalid base32 length/);
    }
  });

  test("rejects unused trailing bits that are not zero", () => {
    // Each is a valid encoding with one or more of the padding bits of the
    // final character flipped.
    for (const text of ["MZ", "MZXR", "MZXW7", "MZXW6YR", "MZXW6YTBOJ"]) {
      expect(() => base32Decode(text), text).toThrow(/trailing bits/);
    }
  });

  test("round-trips random bytes", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });
});

describe("hotp", () => {
  test("matches the RFC 4226 test vectors", async () => {
    // RFC 4226, appendix D: the secret "12345678901234567890" and the
    // counters 0 to 9.
    const secret = ascii("12345678901234567890");
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (let counter = 0; counter < expected.length; counter++) {
      expect(
        await hotp(secret, counter, { algorithm: "SHA-1", digits: 6 }),
        `counter ${counter}`,
      ).toBe(expected[counter]);
    }
  });

  test("handles a counter above 2^32", async () => {
    // The high 4 bytes of the counter are not zero here, thus a mistake in
    // the split of the counter into two 32-bit halves gives a different code
    // from the one for the low half alone.
    const secret = ascii("12345678901234567890");
    const options = { algorithm: "SHA-1", digits: 6 } as const;
    expect(await hotp(secret, 2 ** 32 + 1, options)).not.toBe(
      await hotp(secret, 1, options),
    );
  });
});

describe("totp", () => {
  // RFC 6238, appendix B. Each algorithm uses a secret of its own size,
  // made of the repeated ASCII digits, and 8 digits.
  const seed = "1234567890";
  const secrets = {
    "SHA-1": base32Encode(ascii(seed.repeat(2))),
    "SHA-256": base32Encode(ascii(seed.repeat(4).slice(0, 32))),
    "SHA-512": base32Encode(ascii(seed.repeat(7).slice(0, 64))),
  };
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];

  test.each(["SHA-1", "SHA-256", "SHA-512"] as const)(
    "matches the RFC 6238 test vectors for %s",
    async (algorithm) => {
      const column = { "SHA-1": 1, "SHA-256": 2, "SHA-512": 3 }[algorithm];
      for (const vector of vectors) {
        const seconds = vector[0];
        expect(
          await totp(
            { secret: secrets[algorithm], algorithm, digits: 8, period: 30 },
            seconds * 1000,
          ),
          `T=${seconds}`,
        ).toBe(vector[column]);
      }
    },
  );

  test("computes the time-step counter", () => {
    expect(totpCounter(0, 30)).toBe(0);
    expect(totpCounter(29_999, 30)).toBe(0);
    expect(totpCounter(30_000, 30)).toBe(1);
    expect(totpCounter(1111111109_000, 30)).toBe(37037036);
  });
});

describe("generateSecret", () => {
  test("gives a 160-bit secret, different each time", () => {
    const a = generateSecret();
    const b = generateSecret();
    // 20 bytes are 160 bits.
    expect(a.length).toBe(20);
    expect(a).not.toEqual(b);
  });
});

describe("otpauthUri", () => {
  const params = {
    secret: "MZXW6YTBOI",
    algorithm: "SHA-1",
    digits: 6,
    period: 30,
  } as const;

  test("builds the key URI", () => {
    expect(
      otpauthUri({
        ...params,
        issuer: "Acme",
        accountName: "alice@example.com",
      }),
    ).toBe(
      "otpauth://totp/Acme:alice%40example.com?secret=MZXW6YTBOI&issuer=Acme&algorithm=SHA1&digits=6&period=30",
    );
  });

  test("percent-encodes the issuer and the account name", () => {
    const uri = otpauthUri({
      ...params,
      issuer: "Acme Corp & Co",
      accountName: "alice: bob",
    });
    expect(uri).toBe(
      "otpauth://totp/Acme%20Corp%20%26%20Co:alice%3A%20bob?secret=MZXW6YTBOI&issuer=Acme%20Corp%20%26%20Co&algorithm=SHA1&digits=6&period=30",
    );
    // A URL parser gets the values back.
    const url = new URL(uri);
    expect(url.searchParams.get("issuer")).toBe("Acme Corp & Co");
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(
      "Acme Corp & Co:alice: bob",
    );
  });

  test("rejects an issuer with a colon", () => {
    expect(() =>
      otpauthUri({
        ...params,
        issuer: "Acme: Staging",
        accountName: "alice@example.com",
      }),
    ).toThrow(/must not contain a colon/);
  });
});

describe("timingSafeEqual", () => {
  test("compares strings", () => {
    expect(timingSafeEqual("123456", "123456")).toBe(true);
    expect(timingSafeEqual("123456", "123457")).toBe(false);
    expect(timingSafeEqual("123456", "12345")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
