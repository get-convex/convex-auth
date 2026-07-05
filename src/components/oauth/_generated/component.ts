/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    public: {
      complete: FunctionReference<
        "action",
        "internal",
        { code: string; state: string },
        {
          claims: { profile: any; provider: string; providerAccountId: string };
          intent: "session" | "authenticate";
        },
        Name
      >;
      redeem: FunctionReference<
        "mutation",
        "internal",
        { code: string; verifier: string },
        {
          claims: { profile: any; provider: string; providerAccountId: string };
          intent: "session" | "authenticate";
        } | null,
        Name
      >;
      start: FunctionReference<
        "action",
        "internal",
        { intent?: "session" | "authenticate" },
        { url: string },
        Name
      >;
    };
  };
