import { afterEach, describe, expect, test, vi } from "vitest";
import { isLocalHost } from "../../src/server/utils";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLocalHost", () => {
  test.each([
    "localhost",
    "localhost:3000",
    "http://localhost:3211",
    "127.0.0.1:3000",
    "http://127.0.0.1:3211",
    "[::1]:3000",
  ])("recognizes loopback host %s", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  test.each([
    "10.0.0.1:3000",
    "172.16.0.1:3000",
    "172.31.255.255:3000",
    "192.168.1.13:3000",
    "http://192.168.1.13:3000",
    "light-workers.local:3000",
  ])("recognizes development host %s", (host) => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isLocalHost(host)).toBe(true);
  });

  test.each([
    "172.15.255.255:3000",
    "172.32.0.1:3000",
    "192.169.1.13:3000",
    "8.8.8.8:3000",
    "example.com",
    "999.168.1.13:3000",
    undefined,
  ])("rejects non-local host %s", (host) => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isLocalHost(host)).toBe(false);
  });

  test.each(["192.168.1.13:3000", "light-workers.local:3000"])(
    "does not disable secure cookies for private production host %s",
    (host) => {
      vi.stubEnv("NODE_ENV", "production");
      expect(isLocalHost(host)).toBe(false);
    },
  );
});
