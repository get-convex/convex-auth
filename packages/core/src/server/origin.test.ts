import { describe, expect, test } from "vitest";
import { isTrustedOrigin } from "./origin";

function request(headers: Record<string, string>): Request {
  return new Request("https://app.test/auth/refresh", {
    method: "POST",
    headers,
  });
}

describe("isTrustedOrigin", () => {
  test("trusts an Origin matching the Host header", () => {
    expect(
      isTrustedOrigin(
        request({ origin: "https://app.test", host: "app.test" }),
      ),
    ).toBe(true);
  });

  test("host comparison includes the port", () => {
    expect(
      isTrustedOrigin(
        request({ origin: "http://localhost:3000", host: "localhost:3000" }),
      ),
    ).toBe(true);
    expect(
      isTrustedOrigin(
        request({ origin: "http://localhost:4000", host: "localhost:3000" }),
      ),
    ).toBe(false);
  });

  test("refuses a cross-site Origin", () => {
    expect(
      isTrustedOrigin(
        request({ origin: "https://evil.test", host: "app.test" }),
      ),
    ).toBe(false);
  });

  test("refuses a subdomain of the Host", () => {
    expect(
      isTrustedOrigin(
        request({ origin: "https://sub.app.test", host: "app.test" }),
      ),
    ).toBe(false);
  });

  test("refuses a missing Origin", () => {
    expect(isTrustedOrigin(request({ host: "app.test" }))).toBe(false);
  });

  test('refuses the literal "null" origin (sandboxed iframe)', () => {
    expect(isTrustedOrigin(request({ origin: "null", host: "app.test" }))).toBe(
      false,
    );
  });

  test("refuses an unparseable Origin", () => {
    expect(
      isTrustedOrigin(request({ origin: "not a url", host: "app.test" })),
    ).toBe(false);
  });

  test("trusts a configured allowed origin", () => {
    const req = request({ origin: "https://public.test", host: "internal" });
    expect(isTrustedOrigin(req, ["https://public.test"])).toBe(true);
    // A bare host works too.
    expect(isTrustedOrigin(req, ["public.test"])).toBe(true);
    expect(isTrustedOrigin(req, ["https://other.test"])).toBe(false);
  });
});
