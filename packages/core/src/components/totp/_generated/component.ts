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
    enrollment: {
      confirmTotp: FunctionReference<
        "mutation",
        "internal",
        { code: string; userId: string },
        | { backupCodes: Array<string>; success: true }
        | {
            success: false;
            userError:
              { error: "INVALID_CODE" } | { error: "NO_PENDING_ENROLLMENT" };
          },
        Name
      >;
      createTotp: FunctionReference<
        "mutation",
        "internal",
        {
          accountDisplayName: string;
          issuerDisplayName: string;
          userId: string;
        },
        { otpauthUri: string; secret: string },
        Name
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { userId: string },
        { enabled: boolean; remainingBackupCodes: number },
        Name
      >;
    };
    management: {
      deleteTotp: FunctionReference<
        "mutation",
        "internal",
        { code: string; kind: "totp" | "backup"; userId: string },
        | { success: true }
        | {
            success: false;
            userError:
              | { error: "INVALID_CODE" }
              | { error: "RATE_LIMITED"; retryAfterMs: number }
              | { error: "NOT_ENROLLED" };
          },
        Name
      >;
      deleteUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        null,
        Name
      >;
      regenerateBackupCodes: FunctionReference<
        "mutation",
        "internal",
        { code: string; kind: "totp" | "backup"; userId: string },
        | { backupCodes: Array<string>; success: true }
        | {
            success: false;
            userError:
              | { error: "INVALID_CODE" }
              | { error: "RATE_LIMITED"; retryAfterMs: number }
              | { error: "NOT_ENROLLED" };
          },
        Name
      >;
    };
    verification: {
      verifyBackupCode: FunctionReference<
        "mutation",
        "internal",
        { code: string; userId: string },
        | { remainingBackupCodes: number; success: true }
        | {
            success: false;
            userError:
              | { error: "INVALID_CODE" }
              | { error: "RATE_LIMITED"; retryAfterMs: number };
          },
        Name
      >;
      verifyCode: FunctionReference<
        "mutation",
        "internal",
        { code: string; userId: string },
        | { success: true }
        | {
            success: false;
            userError:
              | { error: "INVALID_CODE" }
              | { error: "RATE_LIMITED"; retryAfterMs: number };
          },
        Name
      >;
    };
  };
