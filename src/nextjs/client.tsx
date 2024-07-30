"use client";

import { ReactNode, useCallback, useMemo } from "react";
import { AuthProvider } from "../react/client";
import { AuthClient } from "../react/clientType";
import { invalidateCache } from "./server/invalidateCache";

export function ConvexAuthNextjsClientProvider({
  apiRoute,
  serverState,
  storage,
  storageNamespace,
  verbose,
  children,
}: {
  apiRoute?: string;
  serverState: ConvexAuthServerState;
  storage?: "localStorage" | "inMemory";
  storageNamespace?: string;
  verbose?: boolean;
  children: ReactNode;
}) {
  const call: AuthClient["authenticatedCall"] = useCallback(
    async (action, args) => {
      const params = { action, args };
      const response = await fetch(apiRoute ?? "/api/auth", {
        body: JSON.stringify(params),
        method: "POST",
      });
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
  console.log("ConvexAuthNextjsProvider should render first");
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
      storageNamespace={storageNamespace ?? process.env.NEXT_PUBLIC_CONVEX_URL!}
      replaceURL={
        // Not used, since the redirect is handled by the Next.js server.
        (url) => {
          window.history.replaceState({}, "", url);
        }
      }
    >
      {children}
    </AuthProvider>
  );
}

export type ConvexAuthServerState = {
  _state: { token: string | null; refreshToken: string | null };
  _timeFetched: number;
};
