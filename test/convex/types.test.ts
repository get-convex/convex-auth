import { expect, test } from "vitest";
import { MutationCtx, QueryCtx } from "./types";

// Check that MutationCtx extends QueryCtx
export function mutable(ctx: MutationCtx) {
  function immutable(ctx: QueryCtx) {
    return ctx.table("users").firstX();
  }

  return immutable(ctx);
}

test("placeholder", async () => {
  expect(true).toBeTruthy();
});
