import { describe, test } from "vitest";

// `checkStart` reads the client IP through `ctx.meta.getRequestMetadata()`,
// which convex-test does not supply, so every path that reaches it throws in
// tests.
// TODO: enable when convex-test supports ctx.meta.
describe("challenge.rateLimit.checkStart", () => {
  test.skip("reports ok before any sends", () => {});
  test.skip("reports the retry delay once the limit is consumed", () => {});
});
