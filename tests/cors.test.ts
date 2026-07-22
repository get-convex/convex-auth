import { buildCorsHeaders } from "@robelest/convex-auth/server/cors";
import { expect, test } from "vite-plus/test";

// Origin-matched CORS for the credentialed API-key surface is deny-by-default:
// only an allow-listed `Origin` gets an `Access-Control-Allow-Origin` header.
// (`siteUrlsFromEnv` — the old comma-separated SITE_URL parser these assertions
// used to cover — was removed when the origin allow-list moved here; this pins
// the current boundary.)

const ALLOWED = ["https://app.example.com", "https://admin.example.com"];

function requestWithOrigin(origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers.origin = origin;
  return new Request("https://api.example.com/api/data", { method: "GET", headers });
}

test("an allow-listed origin is echoed back (credentialed match)", () => {
  const headers = buildCorsHeaders(
    requestWithOrigin("https://app.example.com"),
    undefined,
    ALLOWED,
  );
  expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
});

test("an origin outside the allow-list is denied — no Access-Control-Allow-Origin", () => {
  const headers = buildCorsHeaders(
    requestWithOrigin("https://evil.example.com"),
    undefined,
    ALLOWED,
  );
  expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
});

test("a request with no Origin header gets no Access-Control-Allow-Origin", () => {
  const headers = buildCorsHeaders(requestWithOrigin(undefined), undefined, ALLOWED);
  expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
});

test("a wildcard allow-list matches any origin", () => {
  const headers = buildCorsHeaders(requestWithOrigin("https://anything.example"), undefined, ["*"]);
  expect(headers["Access-Control-Allow-Origin"]).toBe("*");
});

test("a route-level cors config overrides the default origins", () => {
  // The default origins WOULD allow this request; the explicit config must win
  // and deny it, proving `corsConfig.origins` (not `defaultOrigins`) is used.
  const headers = buildCorsHeaders(
    requestWithOrigin("https://app.example.com"),
    { origins: ["https://other.example.com"] },
    ALLOWED,
  );
  expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
});

test("default origins are resolved lazily from a getter", () => {
  let calls = 0;
  const headers = buildCorsHeaders(
    requestWithOrigin("https://admin.example.com"),
    undefined,
    () => {
      calls += 1;
      return ALLOWED;
    },
  );
  expect(calls).toBe(1);
  expect(headers["Access-Control-Allow-Origin"]).toBe("https://admin.example.com");
});
