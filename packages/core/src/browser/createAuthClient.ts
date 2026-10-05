/**
 * The factory for the {@link AuthClient} of a single-page app.
 *
 * @module
 */
import { ConvexHttpClient } from "convex/browser";
import type { ConvexAuthApi } from "../lib/types.ts";
import { oauth } from "../oauth/client.ts";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "./ambientSignInClient.ts";
import { AuthClient } from "./sessionManager.ts";
import { defaultStorage, type TokenStorage } from "./storage.ts";

/** The `logger` option of a `ConvexHttpClient`. */
export type HttpClientLogger = NonNullable<
  ConstructorParameters<typeof ConvexHttpClient>[1]
>["logger"];

/** Options for {@link createAuthClient}. */
export type CreateAuthClientOptions = {
  /** The Convex deployment URL. */
  url: string;
  /** The app's `refreshSession` and `signOut` mutation references. */
  api: ConvexAuthApi;
  /**
   * Where the session is stored. Defaults to `localStorage` in the browser,
   * and to memory where there is no `localStorage`.
   *
   * React Native apps should pass an implementation, because the memory
   * default signs the user out each time the app closes. An example for Expo:
   *
   * ```ts
   * import * as SecureStore from "expo-secure-store";
   *
   * const secureStorage = {
   *   getItem: SecureStore.getItemAsync,
   *   setItem: SecureStore.setItemAsync,
   *   removeItem: SecureStore.deleteItemAsync,
   * };
   * ```
   */
  storage?: TokenStorage;
  /**
   * The namespace for storage keys. Two clients with the same namespace share
   * a session. Non-alphanumeric characters are ignored. Defaults to `url`.
   */
  storageNamespace?: string;
  /** The logger for the HTTP client that refreshes and signs out. */
  logger?: HttpClientLogger;
  /** Log refresh and lifecycle steps to the console. */
  verbose?: boolean;
  /**
   * The API that runs sign-in functions, usually the app's Convex client.
   * Pass it in plain JavaScript. `ConvexAuthProvider` sets it itself.
   */
  signInApi?: AuthSignInApi;
  /**
   * Ambient sign-ins to set up. Defaults to `[oauth()]`.
   *
   * @internal
   */
  ambientSignIns?: ReadonlyArray<AmbientSignInClient>;
};

/**
 * Create the auth client of a single-page app. Build it once, outside React,
 * and pass it to `ConvexAuthProvider`.
 *
 * ```ts
 * import { createAuthClient } from "@convex-dev/auth/react";
 * import { api } from "../convex/_generated/api";
 *
 * const auth = createAuthClient({
 *   url: import.meta.env.VITE_CONVEX_URL,
 *   api: api.auth,
 * });
 * ```
 *
 * In plain JavaScript, set the sign-in API and the Convex client's token
 * fetcher yourself.
 *
 * ```ts
 * auth.setSignInApi(convex);
 * convex.setAuth((args) => auth.fetchAccessToken(args));
 * await auth.init();
 * ```
 */
export function createAuthClient(options: CreateAuthClientOptions): AuthClient {
  const { url, api } = options;
  // Refresh and sign-out use their own HTTP client. The app's websocket client
  // is paused while it waits for a token, so a refresh sent over it would
  // deadlock.
  const httpClient = new ConvexHttpClient(url, { logger: options.logger });
  const auth = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: (refreshToken) =>
        httpClient.mutation(api.refreshSession, { refreshToken }),
      signOut: async (refreshToken) => {
        await httpClient.mutation(api.signOut, { refreshToken });
      },
    },
    storage: options.storage ?? defaultStorage(),
    storageNamespace: options.storageNamespace ?? url,
    verbose: options.verbose,
    ambientSignIns: options.ambientSignIns ?? [oauth()],
  });
  if (options.signInApi !== undefined) {
    auth.setSignInApi(options.signInApi);
  }
  return auth;
}
