import { describe, expect, test } from "vitest";
import type { ComponentApi } from "../component/_generated/component.ts";
import { setupConvexAuth } from "./setup.ts";

// Setup never calls the component, thus a placeholder is enough.
const component = {} as ComponentApi;

describe("setupConvexAuth", () => {
  test("accepts the default and custom token lifetimes", () => {
    expect(() => setupConvexAuth({ component })).not.toThrow();
    expect(() =>
      setupConvexAuth({
        component,
        accessTokenTtlSeconds: 300,
        refreshTokenTtlSeconds: 3600,
      }),
    ).not.toThrow();
  });

  test("rejects a token lifetime that is not positive", () => {
    expect(() =>
      setupConvexAuth({ component, accessTokenTtlSeconds: 0 }),
    ).toThrow("accessTokenTtlSeconds is 0");
    expect(() =>
      setupConvexAuth({ component, refreshTokenTtlSeconds: NaN }),
    ).toThrow("refreshTokenTtlSeconds is NaN");
  });

  test("rejects an access-token lifetime that is not shorter than the refresh-token lifetime", () => {
    expect(() =>
      setupConvexAuth({
        component,
        accessTokenTtlSeconds: 100,
        refreshTokenTtlSeconds: 100,
      }),
    ).toThrow(/shorter than the refresh-token TTL/);
  });
});
