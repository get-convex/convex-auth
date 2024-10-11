// This file maps to packages/core/src/lib/utils/providers.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431).

import { InternalProvider } from "../../types.js";

export function isOIDCProvider(
  provider: InternalProvider<"oidc" | "oauth">,
): provider is InternalProvider<"oidc"> {
  return provider.type === "oidc";
}

// ConvexAuth: There are several more functions in the original file which we don't need,
// and are omitted here.
