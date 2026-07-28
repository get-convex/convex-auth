/**
 * The contract between the core client and provider clients (auth methods).
 *
 * A provider module exports a setup factory (e.g. `oauth(...)`) producing an
 * {@link AuthProviderClientSetup} the app passes to `ConvexAuthProvider`'s
 * `use` prop. Setups run in two phases, both driven by the core provider:
 *
 * 1. **Setup** — runs synchronously while the `AuthClient` is constructed.
 *    Register actions and seed state in `ctx.client.store` here; values exist
 *    before the app's first render reads them.
 * 2. **Mount** — the optional returned `onMount` runs once per client, on
 *    mount, before the client loads the persisted session. Side-effectful
 *    work belongs here (e.g. handling an OAuth callback URL); a
 *    `withSignInPending` latch set synchronously in `onMount` holds the
 *    loading state through session load.
 *
 * Adapters may register setups the app didn't explicitly opt into (the React
 * binding registers `oauth()` by default), so `onMount` work must be
 * **self-gating**: it may only do expensive work (a storage read, a network
 * call) when it finds local evidence that a flow it owns is actually in
 * progress, such as a namespaced URL param or a storage key the setup itself
 * wrote. Absent that evidence it must return cheaply, so an app that never
 * uses the provider pays nothing on mount.
 *
 * The Convex imports are type-only: like `SpaAuthApi`, this contract keeps
 * provider client logic free of any particular Convex client class, so
 * non-React bindings can drive the same setups.
 */
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type { AuthClient } from "./sessionManager";

/**
 * Call one of the app's public mutations by reference — the minimal calling
 * capability handed to provider setups. Sign-in mutations are safe to run
 * pre-auth on any transport; the core client keeps session refresh on its own
 * HTTP client.
 *
 * Provider clients retry these calls on network errors, so an implementation
 * must tolerate a retry re-executing a call whose first attempt actually
 * committed server-side. The standard Convex client's mutation pipeline is
 * exactly-once, so retries are safe there; a plain-HTTP transport can lose a
 * response after the server commits, and the retry then runs the mutation
 * again. For OAuth that worst case is benign but lossy: the duplicate
 * `completeSignIn` returns `null` (one-time code already redeemed) and the
 * first-minted session is orphaned — its tokens never reach the client and
 * the session just ages out.
 */
export type MutationCaller = <
  Mutation extends FunctionReference<"mutation", "public">,
>(
  reference: Mutation,
  args: FunctionArgs<Mutation>,
) => Promise<FunctionReturnType<Mutation>>;

/**
 * What a provider client's setup receives: the core {@link AuthClient}
 * (storage, keyed store, `setSession`, `withSignInPending`) and a
 * {@link MutationCaller} for the provider's public functions.
 */
export type AuthProviderClientContext = {
  /** The core auth client the setup registers into. */
  client: AuthClient;
  /** Calls the app's public mutations by reference. */
  mutation: MutationCaller;
};

/**
 * A provider client's registration with the core provider, passed via
 * `ConvexAuthProvider`'s `use` prop. See the module docs for the two-phase
 * lifecycle.
 */
export type AuthProviderClientSetup = (
  ctx: AuthProviderClientContext,
) => void | { onMount?: () => void };
