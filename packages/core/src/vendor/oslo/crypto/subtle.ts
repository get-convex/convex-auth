/*
 * Vendored from @oslojs/crypto v1.0.1 (https://github.com/oslo-project/crypto,
 * commit 8b3910f), Copyright (c) 2024 pilcrowOnPaper, MIT license (see LICENSE
 * in this directory). See README.md.
 */

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    c |= a[i]! ^ b[i]!;
  }
  return c === 0;
}
