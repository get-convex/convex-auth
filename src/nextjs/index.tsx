import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";
import { AuthProvider, useAuth } from "../react/client";
import { AuthClient } from "../react/clientType";
import type { TokenStorage } from "../react/index";

/**
 * The server state returned by `convexAuthNextjsServerState`
 * used to initialize the client.
 *
 * You should treat this as an opaque value and never access
 * its properties.
 */
export type ConvexAuthServerState = {
  _state: { token: string | null; refreshToken: string | null };
};

/**
 * Replace your `ConvexProvider` in a Client Component with this component
 * to enable authentication in your Next.js app.
 *
 * You should pass in the `serverState` from a Next.js server component.
 *
 * ```tsx
 * "use client";
 *
 * import {
 *   ConvexAuthNextjsProvider,
 *   ConvexAuthServerState,
 * } from "@convex-dev/auth/nextjs";
 * import { ConvexReactClient } from "convex/react";
 * import { ReactNode } from "react";
 *
 * const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
 *
 * export default function ConvexClientProvider({
 *   authServerState,
 *   children,
 * }: {
 *   authServerState: ConvexAuthServerState;
 *   children: ReactNode;
 * }) {
 *   return (
 *     <ConvexAuthNextjsProvider client={convex} serverState={authServerState}>
 *       {children}
 *     </ConvexAuthNextjsProvider>
 *   );
 * }
 * ```
 */
export function ConvexAuthNextjsProvider({
  client,
  serverState,
  apiRoute,
  storage,
  storageNamespace,
  children,
}: {
  /**
   * Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient).
   */
  client: ConvexReactClient;
  /**
   * The server state returned by `convexAuthNextjsServerState`
   */
  serverState: ConvexAuthServerState;
  /**
   * You can customize the route path that handles authentication
   * actions via this prop and the `apiRoute` option to `convexAuthNextjsMiddleWare`.
   *
   * Defaults to `/api/auth`.
   */
  apiRoute?: string;
  /**
   * Optional custom storage object that implements
   * the {@link TokenStorage} interface, otherwise
   * [`localStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
   * is used.
   */
  storage?: TokenStorage;
  /**
   * Optional namespace for keys used to store tokens. The keys
   * determine whether the tokens are shared or not.
   *
   * Any non-alphanumeric characters will be ignored (for RN compatibility).
   *
   * Defaults to the deployment URL, as configured in the given `client`.
   */
  storageNamespace?: string;
  /**
   * Children components can call Convex hooks
   * and {@link useAuthActions}.
   */
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
  return (
    <AuthProvider
      client={authClient}
      serverState={serverState}
      storage={
        storage ??
        // Handle SSR, Client, etc.
        // Pretend we always have storage, the component checks
        // it in first useEffect.
        (typeof window === "undefined" ? undefined : window?.localStorage)!
      }
      storageNamespace={storageNamespace ?? (client as any).address}
      replaceURL={
        // TODO: Probably use Next.js router
        (url) => {
          window.history.replaceState({}, "", url);
        }
      }
    >
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}
