import { describe, expect, test } from "vitest";
import { httpCookies, serializeCookie } from "./httpCookies.ts";

describe("serializeCookie", () => {
  test("emits the attributes it is given", () => {
    const cookie = serializeCookie("tok", "abc", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60,
      domain: "example.com",
    });
    expect(cookie).toContain("tok=abc");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=60");
    expect(cookie).toContain("Domain=example.com");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("omits attributes that were not set", () => {
    const cookie = serializeCookie("tok", "abc");
    expect(cookie).toBe("tok=abc; Path=/");
  });

  test("url-encodes the value", () => {
    expect(serializeCookie("t", "a b/c")).toContain("t=a%20b%2Fc");
  });

  test("emits SameSite=None for cross-site cookies", () => {
    expect(
      serializeCookie("t", "abc", { sameSite: "none", secure: true }),
    ).toContain("SameSite=None");
  });

  test("floors a non-integer maxAge rather than throwing", () => {
    expect(serializeCookie("t", "abc", { maxAge: 60.7 })).toContain(
      "Max-Age=60",
    );
  });
});

describe("httpCookies", () => {
  const requestWith = (cookieHeader?: string) =>
    new Request("https://app.test/", {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });

  test("reads values from the request Cookie header", () => {
    const cookies = httpCookies(requestWith("a=1; b=hello%20world"));
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("hello world");
    expect(cookies.get("missing")).toBeUndefined();
  });

  test("a foreign cookie with malformed percent-encoding does not throw", () => {
    // A `%` that isn't valid percent-encoding would make a hand-rolled
    // decodeURIComponent throw and fail the whole request; `cookie` falls back
    // to the raw value and still reads our own cookies.
    const cookies = httpCookies(requestWith("other=100%; a=1"));
    expect(cookies.get("other")).toBe("100%");
    expect(cookies.get("a")).toBe("1");
  });

  test("writes reflect back to reads within the request", () => {
    const cookies = httpCookies(requestWith("a=1"));
    cookies.set("a", "2");
    cookies.set("c", "new");
    expect(cookies.get("a")).toBe("2");
    expect(cookies.get("c")).toBe("new");
  });

  test("a deleted cookie reads as undefined", () => {
    const cookies = httpCookies(requestWith("a=1"));
    cookies.delete("a");
    expect(cookies.get("a")).toBeUndefined();
  });

  test("delete emits the path and domain it is given, matching the write", () => {
    const cookies = httpCookies(requestWith("a=1"));
    cookies.delete("a", { path: "/app", domain: "example.com" });

    const headers = new Headers();
    cookies.applyTo(headers);
    const [setCookie] = headers.getSetCookie();

    expect(setCookie).toContain("a=");
    expect(setCookie).toContain("Path=/app");
    expect(setCookie).toContain("Domain=example.com");
    expect(setCookie).toContain("Max-Age=0");
  });

  test("applyTo appends a Set-Cookie per write and delete", () => {
    const cookies = httpCookies(requestWith());
    cookies.set("tok", "abc", { httpOnly: true, path: "/" });
    cookies.delete("stale");

    const headers = new Headers();
    cookies.applyTo(headers);
    const setCookies = headers.getSetCookie();

    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toContain("tok=abc");
    expect(setCookies[0]).toContain("HttpOnly");
    // Deletion expires the cookie in the past with Max-Age=0.
    expect(setCookies[1]).toContain("stale=");
    expect(setCookies[1]).toContain("Max-Age=0");
    expect(setCookies[1]).toContain("Path=/");
  });
});
