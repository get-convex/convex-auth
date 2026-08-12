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
      getProviderAccountId: FunctionReference<
        "query",
        "internal",
        { provider: string; userId: string },
        string | null,
        Name
      >;
      getUserIdByAccount: FunctionReference<
        "query",
        "internal",
        { provider: string; providerAccountId: string },
        string | null,
        Name
      >;
      refresh: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          issuer: string;
          refreshToken: string;
          refreshTokenTtlSeconds?: number;
        },
        {
          accessToken: string;
          accessTokenExpiresAt: number;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        } | null,
        Name
      >;
      renameAccount: FunctionReference<
        "mutation",
        "internal",
        { newProviderAccountId: string; provider: string; userId: string },
        { success: true } | { reason: "ACCOUNT_ID_TAKEN"; success: false },
        Name
      >;
      signIn: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          claims: { profile: any; provider: string; providerAccountId: string };
          createOrUpdateUserHandle: string;
          issuer: string;
          refreshTokenTtlSeconds?: number;
        },
        {
          accessToken: string;
          accessTokenExpiresAt: number;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        },
        Name
      >;
      signOut: FunctionReference<
        "mutation",
        "internal",
        { refreshToken: string },
        null,
        Name
      >;
    };
  };
