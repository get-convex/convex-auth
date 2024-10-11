// This file is adapted from packages/core/src/lib/utils/custom-fetch.ts in the @auth/core package.

import * as o from "oauth4webapi";
import { InternalProvider } from "../../types";
import { customFetch } from "@auth/core";
export { customFetch } from "@auth/core";

export function fetchOpt(provider: InternalProvider<"oauth" | "oidc">) {
  return { [o.customFetch]: provider[customFetch] ?? fetch };
}
