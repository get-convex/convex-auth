// This file is adapted from packages/core/src/lib/utils/custom-fetch.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431).

import * as o from "oauth4webapi";
import type { InternalProvider } from "../../types";
import { customFetch } from "@auth/core";
// ConvexAuth:re-export the symbol from @auth/core
export { customFetch } from "@auth/core";

// ConvexAuth: Expose this internal function so we can use it.
export function fetchOpt(provider: InternalProvider<"oauth" | "oidc">) {
  return { [o.customFetch]: provider[customFetch] ?? fetch };
}
