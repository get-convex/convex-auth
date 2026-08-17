/**
 * The contract between the core client and provider clients (auth methods).
 *
 * A provider module exports a setup factory (e.g. `oauth(...)`) producing an
 * {@link AuthProviderClientSetup} the app passes to `ConvexAuthProvider`'s
 * `providerClients` prop. Each registration carries a unique alphanumeric
 * `id` naming the auth method. The store and storage views the setup
 * receives are scoped by it, so two provider clients (or a provider and the
 * core token keys) can never collide. Setups run in two phases, both driven
 * by the core provider:
 *
 * 1. **Setup**: runs synchronously while the `AuthClient` is constructed.
 *    Register actions and seed state in `ctx.store` here, so values exist
 *    before the app's first render reads them.
 * 2. **Start**: the optional returned `onStart` runs once per client
 *    instance at startup, before the client loads the persisted session.
 *    Side-effectful work belongs here (e.g. handling an OAuth callback
 *    URL). Call `withSignInPending` synchronously in `onStart` around a
 *    sign-in completion, so the auth state reports loading rather than
 *    briefly signed out.
 *
 * The Convex imports are type-only. Like `SpaAuthApi`, this contract keeps
 * provider client logic free of any particular Convex client class, so
 * non-React bindings can drive the same setups.
 */
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type { ScopedKeyedStore } from "./keyedStore";
import type { AuthClient } from "./sessionManager";
import type { ScopedStorage } from "./storage";

/**
 * How a provider's sign-in functions get executed. Provider code takes this
 * as given, at setup time via {@link AuthProviderClientContext} and in hooks
 * via `useAuthSignInApi`, instead of picking a transport itself. Executing
 * the call is the only thing that differs between the two session models, so
 * one implementation of a provider serves both:
 *
 *  - SPA: called against the deployment, returning the full `TokenBundle`
 *    for client JS to persist.
 *  - SSR: called through the auth proxy on the SSR host, returning an
 *    access-only `SlimTokenBundle` (the refresh token stays server-side).
 *
 * A provider never sees which model it is running under.
 *
 * Sign-in functions are safe to run before authentication on any transport.
 * Callers retry them on network errors, so a sign-in function must tolerate
 * re-executing after an attempt that already committed server-side.
 */
export interface AuthSignInApi {
  mutation<F extends FunctionReference<"mutation", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
  action<F extends FunctionReference<"action", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}

/** What a provider client's setup receives. */
export type AuthProviderClientContext = {
  /** The core auth client the setup registers into. */
  client: AuthClient;
  /** The client's keyed store, scoped to this setup's id. */
  store: ScopedKeyedStore;
  /** The client's persistent storage, scoped to this setup's id. */
  storage: ScopedStorage;
  /** Runs the provider's sign-in functions by reference. */
  signInApi: AuthSignInApi;
};

/**
 * A provider client's registration with the core provider, passed via
 * `ConvexAuthProvider`'s `providerClients` prop. See the module docs for the
 * two-phase lifecycle.
 */
export type AuthProviderClientSetup = {
  /**
   * Unique name for the auth method (e.g. `"oauth"`). Alphanumeric only.
   * Scopes the setup's store and storage keys. Registering an invalid or
   * duplicate id throws.
   */
  id: string;
  /** The setup function. Runs while the `AuthClient` is constructed. */
  setup: (ctx: AuthProviderClientContext) => void | { onStart?: () => void };
};

/**
 * Run provider client setups against a client, handing each its scoped
 * views. Returns the collected `onStart` callbacks in registration order,
 * each paired with its setup id so the binding (React, or a non-React one)
 * can run them at startup and name the provider if one fails. Throws when
 * two setups share an id.
 */
export function registerProviderClientSetups({
  client,
  signInApi,
  setups,
}: {
  client: AuthClient;
  signInApi: AuthSignInApi;
  setups: ReadonlyArray<AuthProviderClientSetup>;
}): Array<{ id: string; onStart: () => void }> {
  const seen = new Set<string>();
  return setups.flatMap(({ id, setup }) => {
    if (!/^[a-zA-Z0-9]+$/.test(id)) {
      throw new Error(
        `Provider client setup id "${id}" is invalid; ids must be alphanumeric`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `Provider client setup id "${id}" is registered twice; each auth ` +
          `method registers once per ConvexAuthProvider`,
      );
    }
    seen.add(id);
    const registration = setup({
      client,
      store: client.store.scoped(id),
      storage: client.scopedStorage(id),
      signInApi,
    });
    return registration?.onStart === undefined
      ? []
      : [{ id, onStart: registration.onStart }];
  });
}
