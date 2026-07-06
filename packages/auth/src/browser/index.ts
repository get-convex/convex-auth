/**
 * Browser-first auth client for `@robelest/convex-auth/browser`.
 *
 * This entrypoint wraps the framework-agnostic `client(...)`
 * helper with browser defaults such as `ConvexHttpClient`, local storage, URL
 * replacement, OAuth launching, and passkey adapters.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";

import {
  client as createClient,
  resolveUrl,
  type AuthApiRefs,
  type ClientOptions,
  type PlatformAuthClient,
} from "../client/index";
import { createPasskeyClient } from "./passkey";
import { createBrowserRuntime } from "./runtime";

export type { AuthApiRefs, PlatformAuthClient as AuthClient, ClientOptions } from "../client/index";

/**
 * Create a browser-configured auth client.
 *
 * Applies browser runtime defaults (`ConvexHttpClient` transport, local
 * storage, URL cleanup, OAuth launch, passkey support) on top of the
 * framework-agnostic `client(...)` helper, then returns it directly — the core
 * owns OAuth launch/completion and initialization, driven by the injected
 * browser runtime.
 *
 * @param options - Browser client configuration. See {@link ClientOptions}.
 * @typeParam Api - Auth API references that control which factor helpers are
 *   available on the returned client.
 * @returns A browser auth client with the configured auth helpers.
 */
export function client<Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs>(
  options: ClientOptions<Api>,
): PlatformAuthClient<Api> {
  const proxyMode = options.proxyPath !== undefined;
  const url = proxyMode ? undefined : (options.url ?? resolveUrl(options.convex));

  return createClient({
    ...options,
    storage: options.storage === undefined && proxyMode ? null : options.storage,
    runtime: mergeBrowserRuntime(options.runtime),
    adapterFactories: {
      ...options.adapterFactories,
      passkey: options.adapterFactories?.passkey ?? ((deps) => createPasskeyClient(deps)),
    },
    httpClient: proxyMode ? null : (options.httpClient ?? (url ? new ConvexHttpClient(url) : null)),
  }) as PlatformAuthClient<Api>;
}

function mergeBrowserRuntime(
  runtime: ClientOptions["runtime"],
): NonNullable<ClientOptions["runtime"]> {
  const defaults = createBrowserRuntime();
  return {
    ...defaults,
    ...runtime,
    environment: runtime?.environment ?? defaults.environment,
    proxy: runtime?.proxy ?? defaults.proxy,
    storage: runtime?.storage === undefined ? defaults.storage : runtime.storage,
    location: runtime?.location ?? defaults.location,
    oauth: runtime?.oauth ?? defaults.oauth,
    sync: runtime?.sync ?? defaults.sync,
    mutex: runtime?.mutex ?? defaults.mutex,
  };
}
