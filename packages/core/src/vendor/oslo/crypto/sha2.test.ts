// Ported from @oslojs/crypto (https://github.com/oslo-project/crypto),
// MIT license. See README.md in this directory.
import { expect, test } from "vitest";
import { sha256, SHA256 } from "./sha2.ts";

test("SHA256", () => {
  const randomValues = crypto.getRandomValues(new Uint8Array(5 * 100));
  for (let i = 0; i < randomValues.byteLength / 5; i++) {
    const expected = sha256(randomValues.slice(0, i * 5));
    const hash = new SHA256();
    for (let j = 0; j < i; j++) {
      hash.update(randomValues.slice(j * 5, (j + 1) * 5));
    }
    expect(hash.digest()).toStrictEqual(expected);
  }
});

test("SHA256 matches WebCrypto", async () => {
  for (const size of [0, 1, 31, 32, 33, 63, 64, 65, 1000]) {
    const data = crypto.getRandomValues(new Uint8Array(size));
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", data),
    );
    expect(sha256(data)).toStrictEqual(expected);
  }
});
