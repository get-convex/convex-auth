// This file is adapted from packages/core/src/lib/utils/custom-fetch.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431).

import * as o from "oauth4webapi";
import type { InternalProvider } from "../../types";
import { customFetch } from "@auth/core";
import { OAuthConfig } from "@auth/core/providers/index.js";
// ConvexAuth:re-export the symbol from @auth/core
export { customFetch } from "@auth/core";

type FetchOptResult = {
  [o.customFetch]: typeof fetch;
};

// ConvexAuth: Expose this internal function so we can use it.
// ConvexAuth: Make a version that works on InternalProvider and OAuthConfig
export function fetchOpt(providerOrConfig: InternalProvider<"oauth" | "oidc"> | OAuthConfig<any>): FetchOptResult {
  return { [o.customFetch]: providerOrConfig[customFetch] ?? fetch };
}