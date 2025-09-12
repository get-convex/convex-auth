"use client";

import { ReactNode, useCallback, useMemo } from "react";
import { AuthProvider } from "../react/client.js";
import { AuthClient } from "../react/clientType.js";
import { invalidateCache } from "./server/invalidateCache.js";

export function ConvexAuthNextjsClientProvider({
  apiRoute,
  serverState,
  storage,
  storageNamespace,
  shouldHandleCode,
  verbose,
  children,
}: {
  apiRoute?: string;
  serverState: ConvexAuthServerState;
  storage?: "localStorage" | "inMemory";
  storageNamespace?: string;
  verbose?: boolean;
  shouldHandleCode?: (() => boolean) | boolean;
  children: ReactNode;
}) {
  const call: AuthClient["authenticatedCall"] = useCallback(
    async (action, args) => {
      const params = { action, args };
      const response = await fetch(apiRoute ?? "/api/auth", {
        body: JSON.stringify(params),
        method: "POST",
      });
      // Match error handling of Convex Actions
      if (response.status >= 400) {
        throw new Error((await response.json()).error);
      }
      return await response.json();
    },
    [apiRoute],
  );
  const authClient = useMemo(
    () => ({
      authenticatedCall: call,
      unauthenticatedCall: call,
      verbose,
    }),
    [call, verbose],
  );
  return (
    <AuthProvider
      client={authClient}
      serverState={serverState}
      onChange={invalidateCache}
      storage={
        // Handle SSR, Client, etc.
        // Pretend we always have storage, the component checks
        // it in first useEffect.
        (typeof window === "undefined"
          ? undefined
          : storage === "inMemory"
            ? null
            : window.localStorage)!
      }
      storageNamespace={
        storageNamespace ??
        requireEnv(process.env.NEXT_PUBLIC_CONVEX_URL, "NEXT_PUBLIC_CONVEX_URL")
      }
      replaceURL={
        // Not used, since the redirect is handled by the Next.js server.
        (url) => {
          window.history.replaceState({}, "", url);
        }
      }
      shouldHandleCode={shouldHandleCode}
    >
      {children}
    </AuthProvider>
  );
}

function requireEnv(value: string | undefined, name: string) {
  if (value === undefined) {
    throw new Error(`Missing environment variable \`${name}\``);
  }
  return value;
}

export type ConvexAuthServerState = {
  _state: { token: string | null; refreshToken: string | null };
  _timeFetched: number;
};
