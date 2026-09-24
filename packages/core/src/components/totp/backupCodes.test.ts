import { describe, expect, test, vi } from "vitest";
import {
  BACKUP_CODE_COUNT,
  generateBackupCodes,
  hashBackupCode,
} from "./backupCodes.ts";

describe("generateBackupCodes", () => {
  test("gives distinct codes in the displayed form", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    for (const code of codes) {
      // Five characters, a hyphen, five characters, from Crockford's alphabet.
      expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
    }
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
  });

  test("draws again when a code repeats", () => {
    // The first two draws give the same bytes, the rest are distinct.
    let draw = 0;
    const spy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as unknown as Uint8Array;
        bytes.fill(draw === 0 ? 0 : draw - 1);
        draw++;
        return array;
      });
    try {
      const codes = generateBackupCodes();
      expect(codes).toHaveLength(BACKUP_CODE_COUNT);
      expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
      expect(draw).toBe(BACKUP_CODE_COUNT + 1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("hashBackupCode", () => {
  test("hashes a generated code the same with and without its hyphen", async () => {
    for (const code of generateBackupCodes()) {
      expect(await hashBackupCode(code), code).toBe(
        await hashBackupCode(code.replace("-", "")),
      );
    }
  });

  test("ignores the case, the hyphen and spaces", async () => {
    const expected = await hashBackupCode("a2b3cd4e5f");
    for (const code of [" A2B3C D4E5F ", "A2B3C-D4E5F", "a2b3c-d4e5f"]) {
      expect(await hashBackupCode(code), code).toBe(expected);
    }
  });

  test("reads the letters outside the alphabet as the digits they resemble", async () => {
    expect(await hashBackupCode("OoIiLl")).toBe(await hashBackupCode("001111"));
  });

  test("gives different hashes for different codes", async () => {
    expect(await hashBackupCode("a2b3c-d4e5f")).not.toBe(
      await hashBackupCode("a2b3c-d4e5g"),
    );
  });
});
