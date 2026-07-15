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
    provider: {
      claimTicket: FunctionReference<
        "mutation",
        "internal",
        { ottHash: string; stateHash: string },
        null | {
          claims?: any;
          provider: string;
          userInfoResponses?: Record<string, any>;
        },
        Name
      >;
      createAuthorizationRequest: FunctionReference<
        "mutation",
        "internal",
        {
          codeVerifier?: string;
          provider: string;
          redirectTo: string;
          stateHash: string;
          tokenEndpoint: string;
          userinfoEndpoints?: Record<string, string>;
        },
        { callbackBaseUrl: string; clientId: string },
        Name
      >;
    };
  };
