/**
 * Password provider default-crypto tests (audit finding H16 — provider config
 * was ZERO coverage).
 *
 * `password()` ships a scrypt-based `crypto` by default. These assert the
 * hash-string format the storage layer relies on and the verify contract
 * (accepts the right password, rejects a wrong one, rejects a tampered hash).
 * scrypt with N=16384,r=16 is CPU-heavy, so this lives in the node project
 * (60s timeout) rather than the 10s edge-runtime project.
 */

import { password } from "@robelest/convex-auth/providers/password";
import { expect, test } from "vite-plus/test";

test("password() default crypto round-trips a scrypt hash", async () => {
  const { crypto } = password();
  const hash = await crypto!.hashSecret("correct horse battery staple");

  // Documented format: scrypt:N=...,r=...,p=...,dkLen=...$<saltHex>$<hashHex>.
  expect(hash).toMatch(/^scrypt:N=16384,r=16,p=1,dkLen=64\$[0-9a-f]{64}\$[0-9a-f]{128}$/);

  await expect(crypto!.verifySecret("correct horse battery staple", hash)).resolves.toBe(true);
  await expect(crypto!.verifySecret("wrong password", hash)).resolves.toBe(false);
});

test("password() verifySecret rejects a hash with the wrong prefix/params", async () => {
  const { crypto } = password();
  // A well-formed-looking hash but with tampered scrypt params must not verify.
  const bogus = `scrypt:N=1024,r=1,p=1,dkLen=64$${"ab".repeat(32)}$${"cd".repeat(64)}`;
  await expect(crypto!.verifySecret("anything", bogus as never)).resolves.toBe(false);
});
