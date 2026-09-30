/**
 * React bindings for Convex Auth.
 *
 * Wrap your app in {@link ConvexAuthProvider} (in place of `ConvexProvider`) to
 * enable authentication. The provider owns the token lifecycle — storing the
 * session, refreshing the access token, signing out — and feeds Convex's
 * `ConvexProviderWithAuth` a `useAuth` hook.
 *
 * Authentication methods are deliberately not part of this core: each auth provider
 * (password, OAuth, passkey, …) ships its own authentication API that returns a
 * {@link TokenBundle}. Hand that bundle to {@link useAuthActions}'s `setSession`
 * which allows the Convex client to authenticate with the backend.
 *
 * @module
 */
"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../browser/ambientSignInClient.ts";
import { AuthClient } from "../browser/sessionManager.ts";
import { TokenStorage, defaultStorage } from "../browser/storage.ts";
import { oauth } from "../oauth/client.ts";
import type {
  AttemptToken,
  ClientView,
  ContinueSignInFn,
  ContinueSignInResult,
  ConvexAuthApi,
  SignInIncomplete,
} from "../lib/types.ts";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
  useAuthSignInApi,
  usePendingSignInContext,
  type PendingSignInState,
} from "./client.tsx";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export type { AmbientSignInClient } from "../browser/ambientSignInClient.ts";
export type { TokenStorage } from "../browser/storage.ts";
export type {
  AttemptToken,
  ContinueSignInFn,
  ContinueSignInResult,
  ConvexAuthApi,
  SignInIncomplete,
  TokenBundle,
} from "../lib/types.ts";
export type {
  ConvexAuthActionsContextType,
  PendingSignInState,
} from "./client.tsx";
export { useAuthSignInApi, type AuthSignInApi } from "./client.tsx";

/**
 * Replace your `ConvexProvider` with this to enable authentication.
 *
 * ```tsx
 * import { ConvexAuthProvider } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
 *
 * function Root({ children }: { children: React.ReactNode }) {
 *   return (
 *     <ConvexAuthProvider
 *       client={convex}
 *       api={{ refreshSession: api.auth.refreshSession, signOut: api.auth.signOut }}
 *     >
 *       {children}
 *     </ConvexAuthProvider>
 *   );
 * }
 * ```
 */
export function ConvexAuthProvider({
  client,
  api,
  storage,
  storageNamespace,
  ambientSignIns,
  children,
}: {
  /** Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient). */
  client: ConvexReactClient;
  /** The app's `refreshSession` and `signOut` mutation references. */
  api: ConvexAuthApi;
  /**
   * A custom {@link TokenStorage} implementation.
   *
   * If none is supplied, the system defaults to `localStorage` in the browser
   * and in-memory where there is no `localStorage` (SSR).
   *
   * Client runtimes with no `localStorage` like React Native are strongly
   * advised to provide an implementation, because the in-memory default will
   * cause users to get logged out each time the app closes.
   *
   * Here's an example of an implementation for Expo that could be passed in
   * here:
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
   * Namespace for storage keys, which determines whether tokens are shared.
   * Non-alphanumeric characters are ignored. Defaults to the deployment URL.
   */
  storageNamespace?: string;
  /**
   * Advanced. Ambient sign-ins run initialization for auth providers that can
   * take action outside of a user activated sign in flow, such as reading an
   * oauth code from a url query param.
   *
   * Setting this replaces the default (`[oauth()]`) entirely rather than adding
   * to it. Pass `[]` to register nothing, or include `oauth()` (from
   * `@convex-dev/auth/providers/oauth/react`) yourself to keep it alongside
   * other sign-ins. Read once when the client is created and not expected to
   * change.
   */
  ambientSignIns?: AmbientSignInClient[];
  children: ReactNode;
}) {
  const { authClient, signInApi } = useMemo(() => {
    // Refresh and sign-out go over a *separate* HTTP client, not the websocket
    // `client`. A refresh happens while `client` is paused waiting for a token,
    // so calling it through `client` would deadlock on the very handshake the
    // refresh is meant to satisfy.
    const httpClient = new ConvexHttpClient(client.url, {
      logger: client.logger,
    });
    // Sign-in functions run against the deployment over the same websocket
    // client as the rest of the app (it isn't paused pre-auth, unlike the
    // refresh path below), so the response carries the full token bundle for
    // `setSession` to persist. The same object serves provider setups here
    // and, via AuthProvider below, provider hooks.
    const signInApi: AuthSignInApi = {
      mutation: (fn, args) => client.mutation(fn, args),
      action: (fn, args) => client.action(fn, args),
    };
    const authClient = new AuthClient({
      mode: "spa",
      authApi: {
        refreshSession: (refreshToken) =>
          httpClient.mutation(api.refreshSession, { refreshToken }),
        signOut: async (refreshToken) => {
          await httpClient.mutation(api.signOut, { refreshToken });
        },
      },
      storage: storage ?? defaultStorage(),
      storageNamespace: storageNamespace ?? client.url,
      ambientSignIns: { signIns: ambientSignIns ?? [oauth()], signInApi },
    });
    return { authClient, signInApi };
    // `client` identity is what matters. The other props are read once at
    // construction and are not expected to change.
  }, [client]);

  return (
    <AuthProvider authClient={authClient} signInApi={signInApi}>
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * Access the auth actions:
 *
 * ```ts
 * const { setSession, signOut } = useAuthActions();
 * ```
 *
 * - `setSession` adopts a {@link TokenBundle} produced by a provider's
 *   sign-in.
 * - `signOut` revokes and clears the session.
 */
export function useAuthActions() {
  const actions = useContext(ConvexAuthActionsContext);
  if (actions === undefined) {
    throw new Error(
      "useAuthActions must be used within a <ConvexAuthProvider>.",
    );
  }
  return actions;
}

/**
 * The current access token (a JWT), or null when signed out.
 *
 * Use it to authenticate requests to your Convex HTTP actions
 * (`Authorization: Bearer <token>`). Treat it as an ID token — do not send it
 * to other servers.
 */
export function useAuthToken() {
  return useContext(ConvexAuthTokenContext);
}

/**
 * The sign-in a provider is holding on requirements (a TOTP code, say), for
 * rendering the step that satisfies them:
 *
 * ```tsx
 * import { usePendingSignIn } from "@convex-dev/auth/react";
 * import { TOTP_REQUIREMENT } from "@convex-dev/auth/totp/react";
 *
 * function LogIn() {
 *   const { pendingSignIn, expired, cancel } = usePendingSignIn();
 *   if (pendingSignIn?.requirements.includes(TOTP_REQUIREMENT)) {
 *     return <CodePrompt onStartOver={cancel} />;
 *   }
 *   return <PasswordForm notice={expired ? "That sign-in expired." : null} />;
 * }
 * ```
 *
 * The sign-in hooks keep it up to date: a provider's hook that returns
 * `incomplete` sets it, a `complete` result clears it, and `SIGN_IN_EXPIRED`
 * from the attempt's step or from `continueSignIn` swaps it for `expired`.
 * It is held in memory only, since its attempt token proves a first factor,
 * so a reload starts the sign-in over.
 *
 * `R` names the requirements the app's sign-ins can be held for, which the
 * `requirements` and the attempt token are typed by. The hook takes it on
 * the app's word, since every provider's sign-in feeds the same pending
 * sign-in; read it off the generated API so that a requirement the backend
 * adds shows up in the app's types:
 *
 * ```ts
 * type Requirement = Extract<
 *   FunctionReturnType<typeof api.auth.signInWithPassword>,
 *   { status: "incomplete" }
 * >["requirements"][number];
 * const { pendingSignIn } = usePendingSignIn<Requirement>();
 * ```
 */
export function usePendingSignIn<
  R extends string = string,
>(): PendingSignInState<R> {
  const { pendingSignIn, expired, cancel } = usePendingSignInContext();
  // The context holds whatever a sign-in hook adopted; `R` narrows it on the
  // caller's word, like the requirements of an `AttemptToken`.
  return {
    pendingSignIn: pendingSignIn as SignInIncomplete<R> | null,
    expired,
    cancel,
  };
}

/**
 * A failure the client produces that the server never returns: the mutation
 * threw (a network blip, a bug, an unexpected server error) rather than
 * resolving to a `userError`. The flow hooks fold that into the result as
 * `OTHER_ERROR` so callers handle *every* failure through the one `userError`
 * switch and never need their own `try`/`catch`. The thrown value is preserved
 * on `cause` for callers that want to inspect or log it.
 */
export type UnexpectedFailure = {
  status: "error";
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * The result of the `continueSignIn` callback from {@link useContinueSignIn},
 * for an attempt whose sign-in can report the requirements `R`.
 *
 * A pending sign-in is judged by the requirements fixed when it was parked,
 * so continuing it reports some of the same ones the call that parked it
 * could: `R` is read off the attempt token (see {@link AttemptToken}).
 */
export type ContinueSignInHookResult<R extends string = string> =
  | ClientView<Exclude<ContinueSignInResult, { status: "incomplete" }>>
  | SignInIncomplete<R>
  | UnexpectedFailure;

/**
 * Client for continuing a sign-in that a provider's hook reported as
 * `incomplete`: wire the app's `continueSignIn` mutation (from `setupCore`)
 * to the core client.
 *
 * A provider that holds a sign-in on a requirement hands the client an
 * `attemptToken`, which {@link usePendingSignIn} holds. The client satisfies
 * the requirement through the requirement's own function, then calls the
 * returned `continueSignIn` with the token. On success this establishes an
 * authenticated session with your Convex backend, like a provider's own
 * sign-in hook does, and clears the pending sign-in.
 *
 * A requirement that ships its own client step (the TOTP recipe's
 * `useTotpSignInStep`) continues the sign-in itself; this hook is for the
 * steps an app builds on its own.
 *
 * ```tsx
 * import { useContinueSignIn, usePendingSignIn } from "@convex-dev/auth/react";
 * import { useMutation } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * function TermsPrompt() {
 *   const { pendingSignIn } = usePendingSignIn();
 *   const accept = useMutation(api.terms.acceptForSignIn);
 *   const { continueSignIn, pending } = useContinueSignIn(api.auth.continueSignIn);
 *   if (pendingSignIn === null) return null;
 *   const { attemptToken } = pendingSignIn;
 *   return (
 *     <button
 *       disabled={pending}
 *       onClick={async () => {
 *         await accept({ attemptToken });
 *         const result = await continueSignIn({ attemptToken });
 *         // "incomplete": another requirement stands, and usePendingSignIn
 *         // names it. SIGN_IN_EXPIRED: usePendingSignIn reports `expired`.
 *       }}
 *     >
 *       Accept and continue
 *     </button>
 *   );
 * }
 * ```
 *
 * @param continueSignInMutation The app's `continueSignIn` mutation reference.
 */
export function useContinueSignIn(continueSignInMutation: ContinueSignInFn) {
  const { adopt } = usePendingSignInContext();
  // Running through the signInApi rather than `useMutation` is what lets this
  // hook serve both session models. See {@link useAuthSignInApi}.
  const signInApi = useAuthSignInApi();
  const [pending, setPending] = useState(false);

  const continueSignIn = useCallback(
    async <R extends string>(args: {
      attemptToken: AttemptToken<R>;
    }): Promise<ContinueSignInHookResult<R>> => {
      setPending(true);
      try {
        // Under SSR the proxy has already slimmed the bundle, so what arrives
        // is the client view whatever the reference's type says.
        // The requirements are narrowed to `R` on the word of the token's
        // type: the core only reports requirements the attempt was parked on.
        const result = (await signInApi.mutation(
          continueSignInMutation,
          args,
        )) as ContinueSignInHookResult<R>;
        await adopt(result);
        return result;
      } catch (cause) {
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      } finally {
        setPending(false);
      }
    },
    [signInApi, continueSignInMutation, adopt],
  );

  return {
    /**
     * Continues the sign-in the attempt token names.
     *
     * Returns an object with a `status` field. `"complete"` means the
     * sign-in finished and the client has established an authenticated
     * session. `"incomplete"` means a requirement still stands, named in
     * `requirements`; satisfy it and call again with the same token.
     * `"error"` carries a `userError`: `SIGN_IN_EXPIRED` when the attempt is
     * gone and the user starts over (and {@link usePendingSignIn} reports
     * `expired`), or `OTHER_ERROR` when the call threw.
     */
    continueSignIn,
    /** `true` while the sign-in is being continued. */
    pending,
  };
}
