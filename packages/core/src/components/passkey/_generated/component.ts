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
    authentication: {
      finishAuthentication: FunctionReference<
        "mutation",
        "internal",
        {
          authenticatorData: ArrayBuffer;
          clientDataJSON: ArrayBuffer;
          credentialId: ArrayBuffer;
          expectedOrigin: string;
          expectedRpId: string;
          purpose: string;
          signature: ArrayBuffer;
        },
        | { passkeyId: string; success: true; userId: string }
        | {
            success: false;
            userError:
              | { error: "UNKNOWN_CREDENTIAL" }
              | { error: "CHALLENGE_EXPIRED" }
              | { error: "VERIFICATION_FAILED" };
          },
        Name
      >;
      startAuthentication: FunctionReference<
        "mutation",
        "internal",
        { purpose: string; userId?: string },
        {
          allowCredentials: Array<{
            id: ArrayBuffer;
            transports?: Array<string>;
          }>;
          challenge: ArrayBuffer;
        },
        Name
      >;
    };
    registration: {
      checkRegistration: FunctionReference<
        "query",
        "internal",
        {
          attestationObject: ArrayBuffer;
          clientDataJSON: ArrayBuffer;
          expectedOrigin: string;
          expectedRpId: string;
        },
        | { success: true }
        | {
            success: false;
            userError:
              { error: "CHALLENGE_EXPIRED" } | { error: "VERIFICATION_FAILED" };
          },
        Name
      >;
      deletePasskey: FunctionReference<
        "mutation",
        "internal",
        { passkeyId: string; userId: string },
        | { success: true }
        | { success: false; userError: { error: "PASSKEY_NOT_FOUND" } },
        Name
      >;
      deleteUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        null,
        Name
      >;
      finishRegistration: FunctionReference<
        "mutation",
        "internal",
        {
          attestationObject: ArrayBuffer;
          clientDataJSON: ArrayBuffer;
          expectedOrigin: string;
          expectedRpId: string;
          name?: string;
          transports?: Array<string>;
          verifiedUserId: string;
        },
        | { passkeyId: string; success: true }
        | {
            success: false;
            userError:
              { error: "CHALLENGE_EXPIRED" } | { error: "VERIFICATION_FAILED" };
          },
        Name
      >;
      listPasskeys: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          createdAt: number;
          credentialId: ArrayBuffer;
          name?: string;
          passkeyId: string;
        }>,
        Name
      >;
      startRegistration: FunctionReference<
        "mutation",
        "internal",
        { userId: string | null },
        {
          challenge: ArrayBuffer;
          excludeCredentials: Array<{
            id: ArrayBuffer;
            transports?: Array<string>;
          }>;
          userHandle: ArrayBuffer;
        },
        Name
      >;
    };
  };
