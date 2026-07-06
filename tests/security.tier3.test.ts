import {
  ProxyRequestError,
  isRetriableProxyRefreshError,
} from "@robelest/convex-auth/client/runtime/proxy";
import { expect, test } from "vite-plus/test";

test("isRetriableProxyRefreshError retries 429", () => {
  expect(isRetriableProxyRefreshError(new ProxyRequestError(429))).toBe(true);
});

test("isRetriableProxyRefreshError still retries 5xx", () => {
  expect(isRetriableProxyRefreshError(new ProxyRequestError(503))).toBe(true);
});

test("isRetriableProxyRefreshError does not retry 4xx other than 429", () => {
  expect(isRetriableProxyRefreshError(new ProxyRequestError(401))).toBe(false);
  expect(isRetriableProxyRefreshError(new ProxyRequestError(403))).toBe(false);
  expect(isRetriableProxyRefreshError(new ProxyRequestError(404))).toBe(false);
});

test("isRetriableProxyRefreshError retries transient network errors", () => {
  expect(isRetriableProxyRefreshError(new TypeError("Failed to fetch"))).toBe(true);
});

test("isRetriableProxyRefreshError classifies on structured status, not a formatted message", () => {
  expect(isRetriableProxyRefreshError(new Error("Proxy request failed: 503"))).toBe(false);
});
