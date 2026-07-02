import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  return t;
}

describe("anonymous auth", () => {
  test("without argument, returns ID", async () => {
    const t = setup();
    const result = await t.mutation(api.provider.signInAnonymous, {});
    expect(result).not.toBe(null);
  });

  test("with returning ID, non matching, throws", async () => {
    const t = setup();
    const result = t.mutation(api.provider.signInAnonymous, { id: "fake id" });
    await expect(result).rejects.toThrow();
  });

  test("with returning ID, matching, returns ID", async () => {
    const t = setup();
    const newId = await t.mutation(api.provider.signInAnonymous, {});
    const returningId = await t.mutation(api.provider.signInAnonymous, {
      id: newId,
    });
    expect(returningId).toEqual(newId);
  });
});
