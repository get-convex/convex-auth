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
      createSession: FunctionReference<
        "mutation",
        "internal",
        {
          userId: string;
          email: string;
          send: {
            handle: string;
            from: string;
            apiKey: string;
            testMode: boolean;
          };
        },
        | { ok: true; session: string }
        | {
            ok: false;
            userError: { error: "RATE_LIMITED"; retryAfterMs: number };
          },
        Name
      >;
      consumeSession: FunctionReference<
        "mutation",
        "internal",
        { session: string; code: string },
        | { valid: true; userId: string; email: string }
        | {
            valid: false;
            error: "INVALID" | "EXPIRED" | "RATE_LIMITED";
            retryAfterMs?: number;
          },
        Name
      >;
    };
  };
