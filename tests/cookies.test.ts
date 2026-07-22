import { SHARED_COOKIE_OPTIONS, redirectToParamCookie } from "@robelest/convex-auth/server/cookies";
import { expect, test } from "vite-plus/test";

// The OAuth flow cookies must ride cross-site redirect chains while staying
// isolated per top-level site. Downgrading any of these flags (dropping
// `httpOnly`, `secure`, `partitioned`, or relaxing `sameSite` away from
// "none") silently weakens CSRF / CHIPS isolation, so pin them.

test("SHARED_COOKIE_OPTIONS carries the cross-site hardening flags", () => {
  expect(SHARED_COOKIE_OPTIONS.httpOnly).toBe(true);
  expect(SHARED_COOKIE_OPTIONS.secure).toBe(true);
  expect(SHARED_COOKIE_OPTIONS.sameSite).toBe("none");
  expect(SHARED_COOKIE_OPTIONS.partitioned).toBe(true);
  expect(SHARED_COOKIE_OPTIONS.path).toBe("/");
});

test("the cookie writer propagates the hardened flags to emitted cookies", () => {
  // Guards against a writer that spreads a downgraded options object.
  const cookie = redirectToParamCookie("google", "/dashboard");
  expect(cookie.options.httpOnly).toBe(true);
  expect(cookie.options.secure).toBe(true);
  expect(cookie.options.sameSite).toBe("none");
  expect(cookie.options.partitioned).toBe(true);
  expect(cookie.options.path).toBe("/");
  // A finite lifetime is layered on top without clobbering the shared flags.
  expect(typeof cookie.options.maxAge).toBe("number");
});
