/**
 * Expo-first auth client for `@robelest/convex-auth/expo`.
 *
 * This entrypoint wraps the framework-agnostic `client(...)` helper with
 * Expo-native defaults such as SecureStore-backed token persistence, auth
 * session launching, and native passkey support.
 *
 * OAuth in Expo uses direct mode only. Do not configure `proxyPath` for Expo
 * OAuth flows because the proxy flow depends on browser cookies and HTML
 * redirects.
 *
 * @module
 */

import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { ConvexHttpClient } from "convex/browser";

import {
  client as createClient,
  resolveUrl,
  type AuthApiRefs,
  type ClientOptions,
  type ClientRuntime,
  type PlatformAuthClient,
} from "../client/index";
import { client as createBrowserClient } from "../browser/index";
import { createExpoPasskeyClient } from "./passkey";

/**
 * Options for the Expo {@link client}.
 *
 * Extends {@link ClientOptions} with Expo auth-session settings used to launch
 * the OAuth flow and resolve the native redirect URI.
 *
 * @typeParam Api - An AuthApiRefs type that controls which factor helpers are
 *   available on the returned client.
 */
export interface ExpoClientOptions<
  Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs,
> extends ClientOptions<Api> {
  /**
   * Expo auth-session options. `redirectUri` overrides the auto-derived
   * redirect URI; `preferEphemeralSession` requests a private browser session.
   */
  authSession?: AuthSession.AuthSessionRedirectUriOptions & {
    redirectUri?: string;
    preferEphemeralSession?: boolean;
  };
}

export type { AuthApiRefs, PlatformAuthClient as AuthClient } from "../client/index";

const secureStoreStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (err) {
      console.error("[auth] Expo SecureStore.getItemAsync failed", { key, err });
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (err) {
      console.error("[auth] Expo SecureStore.setItemAsync failed", { key, err });
      throw err;
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch (err) {
      console.error("[auth] Expo SecureStore.deleteItemAsync failed", { key, err });
      throw err;
    }
  },
};

/**
 * Create an Expo-configured auth client.
 *
 * Native Expo defaults include SecureStore persistence, auth session launch,
 * and native passkey support. Web falls back to the browser entrypoint.
 *
 * OAuth launch and completion are owned by the core client, driven by the Expo
 * `runtime.oauth` provided here: it opens the in-app auth session and returns
 * the callback URL for the core to complete inline.
 *
 * @param options - Expo client configuration. See {@link ExpoClientOptions}.
 * @typeParam Api - Auth API references that control which factor helpers are
 *   available on the returned client.
 * @returns An Expo auth client with the configured auth helpers.
 */
export function client<Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs>(
  options: ExpoClientOptions<Api>,
): PlatformAuthClient<Api> {
  if (isWebRuntime()) {
    return createBrowserClient(options) as PlatformAuthClient<Api>;
  }

  const proxyMode = options.proxyPath !== undefined;
  const url = proxyMode ? undefined : (options.url ?? resolveUrl(options.convex));
  const redirectUri = resolveRedirectUri(options.authSession);

  return createClient({
    ...options,
    oauthRedirectTo: options.oauthRedirectTo ?? redirectUri,
    storage: options.storage === undefined && proxyMode ? null : options.storage,
    runtime: mergeExpoRuntime(options.runtime, {
      redirectUri,
      preferEphemeralSession: options.authSession?.preferEphemeralSession,
      proxyMode,
    }),
    adapterFactories: {
      ...options.adapterFactories,
      passkey: options.adapterFactories?.passkey ?? ((deps) => createExpoPasskeyClient(deps)),
    },
    httpClient: proxyMode ? null : (options.httpClient ?? (url ? new ConvexHttpClient(url) : null)),
  }) as PlatformAuthClient<Api>;
}

function isWebRuntime() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Build the Expo runtime, layering caller overrides over native defaults.
 *
 * Expo intentionally omits `sync` and `mutex` (the cross-tab storage-event
 * bridge and cross-context lock the browser provides). React Native is
 * single-process with no `storage` event and no `navigator.locks`, so both
 * would be no-ops; token refresh falls back to the in-process `localMutex` in
 * the core. This parity gap is deliberate — do not add stubs.
 */
function mergeExpoRuntime(
  runtime: ClientRuntime | undefined,
  oauth: { redirectUri: string; preferEphemeralSession: boolean | undefined; proxyMode: boolean },
): ClientRuntime {
  const defaults: ClientRuntime = {
    environment: "client",
    storage: secureStoreStorage,
    oauth: {
      open: async (authorizeUrl) => {
        if (oauth.proxyMode) {
          throw new Error(
            "Expo OAuth is not supported when `proxyPath` is set. Use direct mode with `api` and an Expo redirect URI.",
          );
        }
        const authResult = await WebBrowser.openAuthSessionAsync(
          authorizeUrl.toString(),
          oauth.redirectUri,
          { preferEphemeralSession: oauth.preferEphemeralSession },
        );
        return authResult.type === "success" ? authResult.url : undefined;
      },
    },
  };
  return {
    ...defaults,
    ...runtime,
    environment: runtime?.environment ?? defaults.environment,
    storage: runtime?.storage === undefined ? defaults.storage : runtime.storage,
    oauth: runtime?.oauth ?? defaults.oauth,
  };
}

function resolveRedirectUri(options: ExpoClientOptions["authSession"]): string {
  if (options?.redirectUri) {
    return options.redirectUri;
  }
  return AuthSession.makeRedirectUri(options);
}
