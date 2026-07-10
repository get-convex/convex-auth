import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  return t;
}

describe("anonymous auth", () => {
  test("createAnonymousAccount, returns ID", async () => {
    const t = setup();
    const result = await t.mutation(api.provider.createAnonymousAccount, {});
    expect(result).not.toBe(null);
  });
});
