"use client";

import { ReactNode } from "react";
import { AuthProvider } from "../react/client";
import { AuthClient } from "../react/clientType";
import { invalidateCache } from "./server/invalidateCache";

export function ConvexAuthNextjsClientProvider({
  apiRoute,
  serverState,
  storage,
  storageNamespace,
  children,
}: {
  apiRoute?: string;
  serverState: ConvexAuthServerState;
  storage?: "localStorage" | "inMemory";
  storageNamespace?: string;
  children: ReactNode;
}) {
  const call: AuthClient["authenticatedCall"] = async (action, args) => {
    const params = { action, args };
    const response = await fetch(apiRoute ?? "/api/auth", {
      body: JSON.stringify(params),
      method: "POST",
    });
    return await response.json();
  };
  const authClient = { authenticatedCall: call, unauthenticatedCall: call };
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
          : storage === "localStorage"
            ? window.localStorage
            : null)!
      }
      storageNamespace={storageNamespace ?? process.env.NEXT_PUBLIC_CONVEX_URL!}
      replaceURL={
        // TODO: Probably use Next.js router
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
