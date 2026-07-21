/**
 * Framework-agnostic auth client for `@robelest/convex-auth/client`.
 *
 * Exposes the {@link client} factory, which wires auth tokens into a Convex
 * transport and returns `signIn`, `signOut`, `subscribe`, `getSnapshot`, and the
 * factor helpers enabled by the configured providers. Platform entrypoints
 * (`browser`, `expo`) layer concrete runtime defaults on top of this.
 *
 * @module
 */

import { ConvexError, Value } from "convex/values";

import { LOG_LEVELS, logMessage } from "../shared/log";
import { retryWithBackoff } from "../shared/retry";
import {
  createDeferred,
  type AuthApiRefs,
  type AuthClient,
  type AuthFlowContext,
  type AuthState,
  type AuthSnapshot,
  type AuthSubscriber,
  type OAuthCompletionResult,
  type ClientAdapterDeps,
  type ClientAdapterFactories,
  type ActionTransport,
  type ClientAdapters,
  type ClientRuntime,
  type ClientOptions,
  type ConvexTransport,
  type DeviceCodeResult,
  type HandshakeWaiter,
  type PendingInvite,
  type SignInActionResult,
  type SignInResult,
} from "./core/types";
import type { AccessToken } from "../shared/brand";
import type { AuthTokens } from "../shared/results";
import { createHandshakeError } from "./errors";
import { createDeviceClient } from "./factors/device";
import { createTotpClient } from "./factors/totp";
import { createInviteManager } from "./runtime/invite";
import { localMutex } from "./runtime/mutex";
import {
  isAuthRefreshRejection,
  isRetriableProxyRefreshError,
  isTransientNetworkError,
  parseProxyErrorBody,
  ProxyRequestError,
} from "./runtime/proxy";
import { createStorageHelpers } from "./runtime/storage";

export type {
  AnonymousParams,
  AuthApiRefs,
  AuthClient,
  AuthState,
  BrowserAuthClient,
  ClientOptions,
  ClientRuntime,
  CodeCompletionParams,
  DeviceClient,
  DeviceCodeResult,
  DevicePollParams,
  DeviceVerifyParams,
  EmailInitiateParams,
  OAuthCompletionResult,
  OAuthSignInParams,
  PasskeyClient,
  PasskeyRegisterOptions,
  PasskeySignInOptions,
  PasskeySignInParams,
  PasswordParams,
  PendingInvite,
  PlatformAuthClient,
  SignInOverloads,
  SignInResult,
  ConnectionParams,
  Storage,
  TotpClient,
  TotpConfirmParams,
  TotpSetupOptions,
  TotpSetupResult,
  TotpVerifyParams,
} from "./core/types";

const VERIFIER_STORAGE_KEY = "__convexAuthOAuthVerifier";
const JWT_STORAGE_KEY = "__convexAuthJWT";
const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";
const INVITE_TOKEN_KEY = "__convexAuthPendingInvite";
const INVITE_EMAIL_KEY = "__convexAuthPendingInviteEmail";

const RETRY_BASE_MS = 500;
const RETRY_MAX_RETRIES = 2;
const DEFAULT_AUTH_HANDSHAKE_TIMEOUT_MS = 5000;
const FORCED_REFRESH_REUSE_MS = 10000;

const retryWithJitteredBackoff = <T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
): Promise<T> =>
  retryWithBackoff(fn, {
    maxRetries: RETRY_MAX_RETRIES,
    baseMs: RETRY_BASE_MS,
    jitterMode: "centered",
    shouldRetry,
  });

/**
 * Resolve the Convex deployment URL from the client.
 *
 * `ConvexReactClient` exposes `.url` directly.
 * `ConvexClient` exposes `.client.url` via `BaseConvexClient`.
 *
 * @param convex - The Convex transport to read the deployment URL from.
 * @param explicit - An explicit URL that short-circuits discovery.
 * @returns The resolved deployment URL.
 * @throws {Error} When no URL can be determined and `explicit` is not provided.
 * @internal
 */
export function resolveUrl(convex: ConvexTransport, explicit?: string): string {
  if (explicit) return explicit;
  const candidate = convex as {
    url?: unknown;
    client?: { url?: unknown } | null;
  };
  const client =
    typeof candidate.client === "object" && candidate.client !== null
      ? candidate.client
      : undefined;
  const url: unknown = candidate.url ?? client?.url;
  if (typeof url === "string") return url;
  throw new Error("Could not determine Convex deployment URL. Pass `url` explicitly.");
}

const STABLE_STRINGIFY_MAX_DEPTH = 32;

function stableStringify(value: unknown, depth = 0): string {
  if (depth > STABLE_STRINGIFY_MAX_DEPTH) {
    throw new Error("stableStringify: input exceeds maximum nesting depth");
  }
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, depth + 1)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildSignInRequestKey(
  provider: string | undefined,
  params: Record<string, Value>,
): string {
  return stableStringify({ provider: provider ?? null, params });
}

function formDataEntries(formData: unknown): Iterable<[string, string | { name: string }]> {
  return formData as Iterable<[string, string | { name: string }]>;
}

function resolveExplicitToken(value: string | null | undefined): AccessToken | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  // A cleared auth cookie surfaces as an empty (or whitespace-only) string
  // during SSR. Treat it as an explicit signed-out seed instead of throwing and
  // crashing the render.
  if (value.trim().length === 0) return null;
  if (value.trim() !== value) {
    throw new Error("The `token` option must not include leading or trailing whitespace.");
  }
  return value as AccessToken;
}

/**
 * Decode the `sub` (subject / user id) claim from a JWT access token without
 * verifying its signature. Used only to compare identities across browser tabs
 * — never for authorization. Returns `null` when the token cannot be decoded.
 */
function decodeJwtSubject(jwt: string): string | null {
  try {
    const payloadSegment = jwt.split(".")[1];
    if (payloadSegment === undefined || payloadSegment.length === 0) {
      return null;
    }
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    if (typeof atob !== "function") {
      return null;
    }
    const claims = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Create a framework-agnostic auth client.
 *
 * Returns an object with `signIn`, `signOut`, `subscribe`, `getSnapshot`, and any
 * factor helpers enabled by your configured providers. Platform-specific
 * passkey support is added by higher-level entrypoints such as
 * `@robelest/convex-auth/browser`.
 *
 * ### SPA mode (default)
 *
 * ```ts
 * import { ConvexClient } from 'convex/browser';
 * import { client } from '@robelest/convex-auth/client';
 * import { api } from '../convex/_generated/api';
 *
 * const convex = new ConvexClient(CONVEX_URL);
 * const auth = client({ convex, api: api.auth });
 * ```
 *
 * ### Proxy mode
 *
 * ```ts
 * const auth = client({
 *   convex,
 *   proxyPath: '/api/auth',
 *   runtime: myRuntime,
 * });
 * ```
 *
 * In proxy mode all auth operations go through the injected proxy runtime.
 * Tokens are stored in httpOnly cookies server-side — the client
 * holds the JWT in memory only.
 *
 * The client resolves auth through a Convex confirmation handshake. For SSR,
 * pass the server-known token via `token` so hydration starts from the same
 * resolved state. The returned client also auto-wires its tokens into the
 * passed Convex client via `setAuth`, so queries and mutations are
 * authenticated without further configuration.
 *
 * While a sign-in handshake is pending, a transient `false` from the Convex
 * client does not reject the session: Convex can emit `false` mid-reauth and a
 * subsequent `true` confirms the same session. Rejection happens only on
 * timeout or when the token actually changes or clears.
 *
 * @param options - Client configuration. See {@link ClientOptions}.
 * @typeParam Api - An AuthApiRefs type determining which factor helpers are available.
 * @returns Auth client with conditional `totp` and `device` helpers.
 * @throws {Error} When the Convex deployment URL cannot be determined and `url` is not passed explicitly.
 * @throws {Error} When `proxyPath` is not set and the `api` option is missing.
 * @throws {Error} When `proxyPath` is set and `runtime.proxy` is missing.
 * @throws {Error} When `token` has leading or trailing whitespace. An empty or
 *   whitespace-only string is treated as an explicit signed-out seed, not an error.
 */
export function client<Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs>(
  options: ClientOptions<Api>,
): AuthClient<Api> {
  const { convex, proxyPath, api: apiRefs } = options;
  const proxy = proxyPath;
  const runtime: ClientRuntime = options.runtime ?? {};
  const adapters: ClientAdapters = options.adapters ?? {};
  const adapterFactories: ClientAdapterFactories = options.adapterFactories ?? {};

  function requireProxyRuntime() {
    if (!runtime.proxy) {
      throw new Error(
        "The `runtime.proxy` option is required when `proxyPath` is set. " +
          "Use `@robelest/convex-auth/browser` for browser defaults or inject a proxy runtime explicitly.",
      );
    }
    return runtime.proxy;
  }

  function requireApiRefs() {
    if (!apiRefs) {
      throw new Error(
        "The `api` option is required when `proxyPath` is not set. " + "Pass { api: api.auth }.",
      );
    }
    return apiRefs;
  }

  function requireHttpClient() {
    if (!httpClient) {
      throw new Error(
        "The `httpClient` option is required when `proxyPath` is not set in a non-browser runtime. " +
          "Use `@robelest/convex-auth/browser` for browser defaults or pass an action-only transport explicitly.",
      );
    }
    return httpClient;
  }

  const storage =
    options.storage !== undefined
      ? options.storage
      : runtime.storage !== undefined
        ? runtime.storage
        : null;
  const proxyRuntime = proxy ? requireProxyRuntime() : null;

  function getLocation(): URL | null {
    if (typeof options.location === "function") return options.location();
    if (options.location instanceof URL) return options.location;
    if (runtime.location) return runtime.location.get();
    return null;
  }

  /**
   * SSR-safe URL parameter reader.
   *
   * Uses the injected location source when provided.
   *
   * @param name - The query parameter name.
   * @returns The parameter value, or `null` if not present or in SSR.
   *
   * @example
   * ```ts
   * const workspaceId = auth.param("workspace");
   * const tab = auth.param("tab") ?? "issues";
   * ```
   */
  function param(name: string): string | null {
    const loc = getLocation();
    return loc?.searchParams.get(name) ?? null;
  }

  function cleanUrlParams(params: string[]) {
    const loc = getLocation();
    if (!loc) return;
    if (!runtime.location) return;
    const searchParams = new URLSearchParams(loc.search);
    let changed = false;
    for (const p of params) {
      if (searchParams.has(p)) {
        searchParams.delete(p);
        changed = true;
      }
    }
    if (changed) {
      const next = searchParams.toString() ? `${loc.pathname}?${searchParams}` : loc.pathname;
      void runtime.location.replace(next);
    }
  }

  const url = proxy ? undefined : resolveUrl(convex, options.url);
  const escapedNamespace = (proxy ?? url!)
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "_");
  const key = (name: string) => `${name}_${escapedNamespace}`;
  const {
    get: storageGet,
    set: storageSet,
    remove: storageRemove,
  } = createStorageHelpers({ storage, key });
  const proxyFetch = async (body: Record<string, unknown>) => {
    if (!proxy) {
      throw new Error("Proxy fetch requested without proxyPath.");
    }
    const response = await proxyRuntime!.fetch(body, proxy);
    if (!response.ok) {
      let errorBody: Record<string, unknown> = {};
      try {
        errorBody = parseProxyErrorBody(await response.json()) as Record<string, unknown>;
      } catch {
        errorBody = {};
      }
      if (
        typeof errorBody === "object" &&
        errorBody !== null &&
        "authError" in errorBody &&
        typeof (errorBody as Record<string, unknown>).authError === "object"
      ) {
        throw new ConvexError((errorBody as Record<string, unknown>).authError as Value);
      }
      throw new ProxyRequestError(
        response.status,
        (errorBody as Record<string, unknown>).error as string | undefined,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error("Proxy response was not valid JSON");
    }
  };
  const subscribers = new Set<() => void>();
  let disposeStorageListener: (() => void) | null = null;

  const httpClient: ActionTransport | null = proxy ? null : (options.httpClient ?? null);

  const readInitialToken = (): AccessToken | null => {
    if (!storage) return null;
    try {
      const raw = storage.getItem(key(JWT_STORAGE_KEY));
      return typeof raw === "string" && raw.length > 0 ? (raw as AccessToken) : null;
    } catch {
      return null;
    }
  };
  const explicitToken = resolveExplicitToken(options.token);
  const tokenProvided = explicitToken !== undefined;
  const serverToken: AccessToken | null = tokenProvided ? explicitToken : readInitialToken();
  const hasServerToken = serverToken !== null;

  const handshakeTimeoutMs =
    typeof options.handshakeTimeoutMs === "number" && options.handshakeTimeoutMs > 0
      ? options.handshakeTimeoutMs
      : DEFAULT_AUTH_HANDSHAKE_TIMEOUT_MS;

  let token: AccessToken | null = serverToken;
  let isLoading = !hasServerToken && !tokenProvided;
  let authConfirmed = hasServerToken;
  let handshakePending = false;
  let authEpoch = 0;
  let lastForcedRefreshTime = 0;
  let forcedRefreshPromise: Promise<string | null> | null = null;
  let destroyed = false;
  // Bounded grace window for a confirmed session that Convex reports as `false`.
  // A transient mid-rotation `false` is followed by a confirming `true` (which
  // clears the timer); a real server-side deauth (revoke/expiry) leaves it to
  // fire and sign out. The timer callback pins itself to the token epoch it was
  // armed for so a concurrent rotation cannot trigger a spurious sign-out.
  let deauthGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSignIn: {
    key: string;
    promise: Promise<SignInResult>;
  } | null = null;
  let initializePromise: Promise<void> | null = null;
  const handshakeWaiters = new Set<HandshakeWaiter>();
  let snapshot: AuthSnapshot = {
    phase: hasServerToken ? "authenticated" : isLoading ? "loading" : "unauthenticated",
    isLoading,
    isAuthenticated: hasServerToken,
    token,
  };

  const computePublic = (): AuthState => {
    if (snapshot.token !== null && snapshot.phase === "authenticated") {
      return { status: "signedIn", token: snapshot.token };
    }
    if (snapshot.phase === "loading" || snapshot.phase === "handshake") {
      return { status: "loading", token: null };
    }
    return { status: "signedOut", token: null };
  };
  let publicSnapshot: AuthState = computePublic();
  const authStatesEqual = (left: AuthState, right: AuthState) =>
    left.status === right.status && left.token === right.token;
  const refreshPublic = (): boolean => {
    const next = computePublic();
    if (authStatesEqual(publicSnapshot, next)) {
      return false;
    }
    publicSnapshot = next;
    return true;
  };

  const settleHandshakeWaiters = (
    epoch: number,
    outcome: { type: "resolve" } | { type: "reject"; error: ConvexError<Value> },
  ) => {
    for (const waiter of Array.from(handshakeWaiters)) {
      if (waiter.epoch !== epoch) {
        continue;
      }
      clearTimeout(waiter.timeoutId);
      handshakeWaiters.delete(waiter);
      if (outcome.type === "resolve") {
        waiter.deferred.resolve(undefined);
      } else {
        waiter.deferred.reject(outcome.error);
      }
    }
  };

  const rejectObsoleteHandshakeWaiters = (activeEpoch: number) => {
    for (const waiter of Array.from(handshakeWaiters)) {
      if (waiter.epoch >= activeEpoch) {
        continue;
      }
      clearTimeout(waiter.timeoutId);
      handshakeWaiters.delete(waiter);
      waiter.deferred.reject(
        createHandshakeError("AUTH_HANDSHAKE_REJECTED", {
          ...waiter.context,
          reason: "token_changed",
        }),
      );
    }
  };

  const rejectAllHandshakeWaiters = (error: ConvexError<Value>) => {
    for (const waiter of Array.from(handshakeWaiters)) {
      clearTimeout(waiter.timeoutId);
      handshakeWaiters.delete(waiter);
      waiter.deferred.reject(error);
    }
  };

  const clearDeauthGrace = () => {
    if (deauthGraceTimer !== null) {
      clearTimeout(deauthGraceTimer);
      deauthGraceTimer = null;
    }
  };

  /**
   * Arm the bounded re-handshake window after Convex reports a confirmed
   * session as unauthenticated. The public snapshot is intentionally left on
   * the confirmed state so a transient mid-rotation `false` does not flicker the
   * UI; only if no confirming `true` arrives before the window elapses (and the
   * token identity is unchanged) do we sign out.
   */
  const startDeauthGrace = () => {
    if (deauthGraceTimer !== null) {
      return;
    }
    const epoch = authEpoch;
    deauthGraceTimer = setTimeout(() => {
      deauthGraceTimer = null;
      if (destroyed || authEpoch !== epoch || !authConfirmed || token === null) {
        return;
      }
      void setToken({ shouldStore: true, tokens: null }).catch((error) => {
        logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
          "[convex-auth] Sign-out after server-side deauthentication failed:",
          error,
        ]);
      });
    }, handshakeTimeoutMs);
  };

  const waitForAuthHandshake = async (context: AuthFlowContext) => {
    if (token === null) {
      return;
    }
    if (authConfirmed && !handshakePending) {
      return;
    }
    if (!handshakePending) {
      throw createHandshakeError("AUTH_HANDSHAKE_REJECTED", {
        ...context,
        reason: "auth_rejected",
      });
    }

    const epoch = authEpoch;
    const deferred = createDeferred<void, ConvexError<Value>>();
    const waiter: HandshakeWaiter = {
      epoch,
      context,
      deferred,
      timeoutId: setTimeout(() => {
        handshakeWaiters.delete(waiter);
        deferred.reject(
          createHandshakeError("AUTH_HANDSHAKE_TIMEOUT", {
            ...context,
            timeoutMs: handshakeTimeoutMs,
          }),
        );
        // Unstick the state machine: a never-confirmed handshake that times out
        // must not leave `handshakePending` set (which would spin the UI in
        // `loading` forever). Drive the still-current, still-pending token to
        // signed-out — but keep the persisted refresh token (shouldStore:false),
        // since a 5s handshake timeout is only a latency signal, not a revoke:
        // a later reload can still recover the session from storage.
        if (!destroyed && authEpoch === epoch && token !== null && handshakePending) {
          void setToken({ shouldStore: false, tokens: null }).catch((error) => {
            logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
              "[convex-auth] Sign-out after handshake timeout failed:",
              error,
            ]);
          });
        }
      }, handshakeTimeoutMs),
    };
    handshakeWaiters.add(waiter);
    try {
      await deferred.promise;
    } finally {
      clearTimeout(waiter.timeoutId);
      handshakeWaiters.delete(waiter);
    }
  };

  const handleConvexAuthChange = (isAuthenticated: boolean) => {
    if (destroyed) {
      return;
    }

    if (isAuthenticated) {
      authConfirmed = true;
      handshakePending = false;
      clearDeauthGrace();
      settleHandshakeWaiters(authEpoch, { type: "resolve" });
    } else if (token === null || !authConfirmed) {
      authConfirmed = false;
      if (token !== null) {
        handshakePending = true;
      }
    } else {
      // A previously confirmed session (`token !== null && authConfirmed`) is
      // now reported unauthenticated. This is ambiguous: it may be a transient
      // mid-rotation `false` (a confirming `true` follows shortly) or a real
      // server-side deauthentication (revoke/expiry). Keep the confirmed
      // snapshot for now and arm a bounded grace window that signs out only if
      // no `true` re-confirms in time.
      startDeauthGrace();
    }

    if (updateSnapshot()) {
      notify();
    }
  };

  const notify = () => {
    refreshPublic();
    for (const cb of subscribers) cb();
  };

  const updateSnapshot = () => {
    const tag =
      token !== null && handshakePending
        ? "handshake"
        : isLoading
          ? "loading"
          : token !== null && authConfirmed
            ? "authenticated"
            : "unauthenticated";

    const phase = tag as AuthSnapshot["phase"];

    const next: AuthSnapshot = {
      phase,
      isLoading: phase === "loading" || phase === "handshake",
      isAuthenticated: phase === "authenticated",
      token,
    };
    if (
      snapshot.phase === next.phase &&
      snapshot.isLoading === next.isLoading &&
      snapshot.isAuthenticated === next.isAuthenticated &&
      snapshot.token === next.token
    ) {
      return false;
    }
    snapshot = next;
    return true;
  };

  const finalizeLoadingState = () => {
    if (!isLoading) {
      return;
    }
    isLoading = false;
    if (updateSnapshot()) {
      notify();
    }
  };

  const inviteManager = createInviteManager({
    param,
    storageGet,
    storageSet,
    storageRemove,
    cleanUrlParams,
    tokenKey: INVITE_TOKEN_KEY,
    emailKey: INVITE_EMAIL_KEY,
  });
  const getPendingInvite = () => inviteManager.getPendingInvite();
  const persistInvite = () => inviteManager.persistInvite();
  const acceptInvite = () => inviteManager.acceptInvite();

  const bindConvexAuth = () => {
    convex.setAuth(fetchAccessToken, handleConvexAuthChange);
  };

  const setToken = async (
    args:
      | {
          shouldStore: true;
          tokens: AuthTokens | null;
          requireHandshake?: boolean;
          resyncConvexAuth?: boolean;
        }
      | {
          shouldStore: false;
          tokens: { token: AccessToken } | null;
          requireHandshake?: boolean;
          resyncConvexAuth?: boolean;
        },
  ) => {
    const previousToken = token;
    const nextToken = args.tokens === null ? null : args.tokens.token;

    // Assign the token and bump the epoch synchronously — before any storage
    // I/O await — so `authEpoch` and `token` never disagree within a tick. The
    // forced-refresh race guard depends on this: a concurrent `signOut` that
    // clears the token must be observable by an in-flight refresh the instant
    // it happens, not only after the storage write resolves.
    token = nextToken;
    const tokenChanged = token !== previousToken;
    if (tokenChanged) {
      authEpoch += 1;
      rejectObsoleteHandshakeWaiters(authEpoch);
      clearDeauthGrace();
    }

    if (args.tokens === null) {
      lastForcedRefreshTime = 0;
      if (args.shouldStore) {
        await storageRemove(JWT_STORAGE_KEY);
        await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
      }
    } else {
      if (args.shouldStore && "refreshToken" in args.tokens) {
        await storageSet(JWT_STORAGE_KEY, args.tokens.token);
        await storageSet(REFRESH_TOKEN_STORAGE_KEY, args.tokens.refreshToken);
      }
    }

    if (token === null) {
      authConfirmed = false;
      handshakePending = false;
      settleHandshakeWaiters(authEpoch, {
        type: "reject",
        error: createHandshakeError("AUTH_HANDSHAKE_REJECTED", {
          reason: "token_cleared",
        }),
      });
    } else {
      const keepConfirmedAuth =
        authConfirmed && args.resyncConvexAuth === false && args.requireHandshake !== true;
      const shouldEnterHandshake =
        !keepConfirmedAuth && (args.requireHandshake === true || tokenChanged || !authConfirmed);
      if (shouldEnterHandshake) {
        authConfirmed = false;
        handshakePending = true;
      } else {
        handshakePending = false;
      }
    }

    const hadPendingLoad = isLoading;
    isLoading = false;
    const changed = updateSnapshot();
    if (args.resyncConvexAuth !== false) {
      bindConvexAuth();
    }
    if (hadPendingLoad || changed) {
      notify();
    }
  };

  const setTokenAndMaybeWait = async (
    args:
      | {
          shouldStore: true;
          tokens: AuthTokens | null;
          waitForHandshake: boolean;
          context: AuthFlowContext;
        }
      | {
          shouldStore: false;
          tokens: { token: AccessToken } | null;
          waitForHandshake: boolean;
          context: AuthFlowContext;
        },
  ): Promise<boolean> => {
    const { waitForHandshake, context, ...tokenArgs } = args;
    await setToken({
      ...(tokenArgs as
        | { shouldStore: true; tokens: AuthTokens | null }
        | { shouldStore: false; tokens: { token: AccessToken } | null }),
      requireHandshake: waitForHandshake,
    });
    if (tokenArgs.tokens === null) {
      return false;
    }
    if (waitForHandshake) {
      await waitForAuthHandshake(context);
    }
    return true;
  };

  const adapterDeps: ClientAdapterDeps = {
    proxy,
    convex,
    requireApiRefs,
    proxyFetch,
    setTokenAndMaybeWait,
  };
  const passkeyAdapter = adapters.passkey ?? adapterFactories.passkey?.(adapterDeps);

  const verifyCode = async (
    args: { code: string; verifier?: string } | { refreshToken: string },
  ) => {
    return retryWithJitteredBackoff(
      () =>
        requireHttpClient().action(
          requireApiRefs().signIn,
          "code" in args ? { params: { code: args.code }, verifier: args.verifier } : args,
        ) as Promise<SignInActionResult>,
      isTransientNetworkError,
    );
  };

  const normalizeDeviceCodeResult = (device_code: unknown): DeviceCodeResult => {
    const input = device_code as {
      deviceCode: string;
      userCode: string;
      verification_uri?: string;
      verificationUri?: string;
      verification_uri_complete?: string;
      verificationUriComplete?: string;
      expiresIn: number;
      interval: number;
    };
    return {
      deviceCode: input.deviceCode,
      userCode: input.userCode,
      verificationUri: input.verification_uri ?? input.verificationUri ?? "",
      verificationUriComplete:
        input.verification_uri_complete ?? input.verificationUriComplete ?? "",
      expiresIn: input.expiresIn,
      interval: input.interval,
    };
  };

  const isSignedInResult = (
    result: SignInActionResult,
  ): result is Extract<SignInActionResult, { kind: "signedIn" }> => result.kind === "signedIn";

  /**
   * Hand an OAuth authorization URL to the platform launcher.
   *
   * Browser-style runtimes navigate away and return nothing, so the caller
   * receives the `redirect` result. Session-style runtimes (Expo) return the
   * callback URL, which is completed inline and resolves to `signedIn`.
   */
  const launchOAuth = async (redirect: URL, verifier: string): Promise<SignInResult> => {
    const redirectResult = { kind: "redirect" as const, redirect, verifier } satisfies SignInResult;
    if (!runtime.oauth) {
      return redirectResult;
    }
    const callback = await runtime.oauth.open(redirect);
    if (callback === undefined) {
      return redirectResult;
    }
    const completion = await completeOAuth(callback);
    return completion.handled ? { kind: "signedIn" as const } : redirectResult;
  };

  /**
   * Sign in with a provider.
   *
   * @param provider - Provider ID (e.g. `"email"`, `"password"`, `"google"`).
   *   Omit when exchanging an OAuth code (the code carries the provider info).
   * @param args - Provider-specific arguments. Pass a `Record<string, Value>`
   *   or `FormData`. Common fields: `email`, `password`, `code`, `redirectTo`.
   * @returns A {@link SignInResult} indicating the outcome.
   * @throws {ConvexError} When the server action rejects the sign-in attempt (e.g. invalid credentials, provider error, or rate limiting).
   *
   * @example Email magic link
   * ```ts
   * await auth.signIn('email', { email: 'user@example.com' });
   * ```
   *
   * @example Password
   * ```ts
   * const result = await auth.signIn('password', { email, password, flow: 'signIn' });
   * if (result.kind === 'totpRequired') {
   *   await auth.totp.verify({ code: totpCode, verifier: result.verifier });
   * }
   * ```
   *
   * @example OAuth (returns a redirect URL)
   * ```ts
   * const result = await auth.signIn('google');
   * if (result.kind === 'redirect') {
   *   window.location.href = result.redirect.toString();
   * }
   * ```
   */
  const signIn = async (
    provider?: string,
    args?: FormData | Record<string, Value>,
  ): Promise<SignInResult> => {
    if (destroyed) {
      throw new Error("Convex auth client has been destroyed.");
    }
    await persistInvite();

    const rawParams =
      args instanceof FormData
        ? (() => {
            const formParams: Record<string, Value> = {};
            for (const [key, value] of formDataEntries(args)) {
              if (typeof value === "string") {
                formParams[key] = value;
              }
            }
            return formParams;
          })()
        : (args ?? {});
    const params: Record<string, Value> =
      options.oauthRedirectTo !== undefined && rawParams.redirectTo === undefined
        ? { ...rawParams, redirectTo: options.oauthRedirectTo }
        : rawParams;
    const flow = typeof params.flow === "string" && params.flow.length > 0 ? params.flow : "signIn";
    const signInKey = buildSignInRequestKey(provider, params);

    const handleSignInActionResult = async (
      result: SignInActionResult,
      resultOptions: { shouldStore: boolean; persistVerifier: boolean },
    ): Promise<SignInResult> => {
      if (result.kind === "redirect") {
        const redirectUrl = new URL(result.redirect);
        if (resultOptions.persistVerifier) {
          await storageSet(VERIFIER_STORAGE_KEY, result.verifier);
        }
        return {
          kind: "redirect" as const,
          redirect: redirectUrl,
          verifier: result.verifier,
        } satisfies SignInResult;
      }

      if (result.kind === "totpRequired") {
        return {
          kind: "totpRequired" as const,
          verifier: result.verifier,
        } satisfies SignInResult;
      }

      if (result.kind === "deviceCode") {
        return {
          kind: "deviceCode" as const,
          deviceCode: normalizeDeviceCodeResult(result.deviceCode),
        } satisfies SignInResult;
      }

      if (result.kind === "signedIn") {
        const signingIn = await setTokenAndMaybeWait(
          resultOptions.shouldStore
            ? {
                shouldStore: true as const,
                tokens: result.session,
                waitForHandshake: true,
                context: { provider, flow },
              }
            : {
                shouldStore: false as const,
                tokens: result.session === null ? null : { token: result.session.token },
                waitForHandshake: true,
                context: { provider, flow },
              },
        );
        return signingIn
          ? ({ kind: "signedIn" as const } satisfies SignInResult)
          : ({ kind: "started" as const } satisfies SignInResult);
      }

      return { kind: "started" as const } satisfies SignInResult;
    };

    if (activeSignIn !== null) {
      if (activeSignIn.key === signInKey) {
        const shared = await activeSignIn.promise;
        return shared.kind === "redirect" ? launchOAuth(shared.redirect, shared.verifier) : shared;
      }
      throw new Error("Another sign-in flow is already in progress.");
    }

    const signInPromise = (async () => {
      if (proxy) {
        const result = (await proxyFetch({
          action: "auth:signIn",
          args: { provider, params },
        })) as SignInActionResult;
        return await handleSignInActionResult(result, {
          shouldStore: false,
          persistVerifier: false,
        });
      }

      const verifier = (await storageGet(VERIFIER_STORAGE_KEY)) ?? undefined;
      try {
        const result = (await convex.action(requireApiRefs().signIn, {
          provider,
          params,
          verifier,
        })) as SignInActionResult;
        if (params.code !== undefined) {
          await storageRemove(VERIFIER_STORAGE_KEY);
        }
        return await handleSignInActionResult(result, {
          shouldStore: true,
          persistVerifier: true,
        });
      } catch (error) {
        if (params.code !== undefined) {
          const convexCode =
            error instanceof ConvexError && typeof error.data?.code === "string"
              ? error.data.code
              : null;
          if (
            convexCode !== null &&
            ["INVALID_VERIFICATION_CODE", "INVALID_VERIFIER"].includes(convexCode)
          ) {
            await storageRemove(VERIFIER_STORAGE_KEY);
          }
        }
        throw error;
      }
    })();

    activeSignIn = { key: signInKey, promise: signInPromise };
    let result: SignInResult;
    try {
      result = await signInPromise;
    } finally {
      if (activeSignIn?.promise === signInPromise) {
        activeSignIn = null;
      }
    }
    if (result.kind === "redirect") {
      return launchOAuth(result.redirect, result.verifier);
    }
    return result;
  };

  /**
   * Sign out the current user.
   *
   * Invalidates the server session and clears local token state.
   * Errors are silently caught — calling `signOut` on an already
   * signed-out user is a no-op.
   */
  const signOut = async () => {
    if (destroyed) return;
    if (proxy) {
      try {
        await proxyFetch({ action: "auth:signOut", args: {} });
      } catch {
        /* empty */
      }
      await setToken({ shouldStore: false, tokens: null });
      if (convex.clearAuth) convex.clearAuth();
      return;
    }

    try {
      await convex.action(requireApiRefs().signOut, {});
    } catch {
      /* empty */
    }
    await setToken({ shouldStore: true, tokens: null });
    if (convex.clearAuth) convex.clearAuth();
  };

  const fetchAccessToken = async ({
    forceRefreshToken,
  }: {
    forceRefreshToken: boolean;
  }): Promise<string | null> => {
    if (destroyed) return null;
    if (!forceRefreshToken) return token;
    if (forcedRefreshPromise !== null) {
      return await forcedRefreshPromise;
    }
    if (token !== null && Date.now() - lastForcedRefreshTime < FORCED_REFRESH_REUSE_MS) {
      return token;
    }

    forcedRefreshPromise = (async () => {
      try {
        return await refreshAccessToken();
      } finally {
        forcedRefreshPromise = null;
      }
    })();
    return await forcedRefreshPromise;
  };

  async function refreshAccessToken(): Promise<string | null> {
    const mutex = runtime.mutex;
    const withMutex = mutex
      ? <T>(key: string, callback: () => Promise<T>) => mutex.withKey(key, callback)
      : localMutex;

    if (proxy) {
      const tokenBeforeRefresh = token;
      return await withMutex(`__convexAuthProxyRefresh_${escapedNamespace}`, async () => {
        if (token !== tokenBeforeRefresh) return token;

        const epochAtRefreshStart = authEpoch;
        try {
          const result = await retryWithJitteredBackoff(
            () =>
              proxyFetch({
                action: "auth:signIn",
                args: { refreshToken: true },
              }) as Promise<SignInActionResult>,
            isRetriableProxyRefreshError,
          );
          // A concurrent signOut / rotation / destroy superseded this refresh:
          // drop the result instead of re-authenticating a stale identity.
          if (destroyed || authEpoch !== epochAtRefreshStart) {
            return token;
          }
          if (isSignedInResult(result) && result.session) {
            await setToken({
              shouldStore: false,
              tokens: { token: result.session.token },
              resyncConvexAuth: false,
            });
            lastForcedRefreshTime = Date.now();
          } else {
            await setToken({
              shouldStore: false,
              tokens: null,
              resyncConvexAuth: false,
            });
          }
        } catch (error) {
          logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
            "[convex-auth] Proxy refresh failed:",
            error,
          ]);
          if (destroyed || authEpoch !== epochAtRefreshStart) {
            return token;
          }
          if (isAuthRefreshRejection(error)) {
            // A proxy 401 / invalid-refresh is a real sign-out. Clearing the
            // token here breaks the Convex re-force-refresh -> 401 loop the old
            // catch-and-retain behavior caused; a transient failure (network,
            // 429, 5xx) still retains the token so the session can recover.
            await setToken({
              shouldStore: false,
              tokens: null,
              resyncConvexAuth: false,
            });
          } else if (token === null) {
            finalizeLoadingState();
          }
        }
        return token;
      });
    }

    const tokenBeforeLockAcquisition = token;
    return await withMutex(key(REFRESH_TOKEN_STORAGE_KEY), async () => {
      const tokenAfterLockAcquisition = token;
      if (tokenAfterLockAcquisition !== tokenBeforeLockAcquisition) {
        return tokenAfterLockAcquisition;
      }
      const refreshToken = (await storageGet(REFRESH_TOKEN_STORAGE_KEY)) ?? null;
      if (!refreshToken) {
        await setToken({ shouldStore: true, tokens: null, resyncConvexAuth: false });
        return null;
      }
      const epochAtRefreshStart = authEpoch;
      try {
        const result = await verifyCode({ refreshToken });
        // Superseded by a concurrent signOut / rotation / destroy: discard the
        // freshly minted token rather than re-authenticating a stale identity.
        if (destroyed || authEpoch !== epochAtRefreshStart) {
          return token;
        }
        if (result.kind !== "signedIn") {
          throw new Error("Code exchange did not return tokens.");
        }
        await setToken({ shouldStore: true, tokens: result.session, resyncConvexAuth: false });
        lastForcedRefreshTime = Date.now();
      } catch (error) {
        if (destroyed || authEpoch !== epochAtRefreshStart) {
          return token;
        }
        if (isAuthRefreshRejection(error)) {
          // The refresh credential was rejected (revoked/expired): sign out and
          // delete the stored refresh token.
          await setToken({ shouldStore: true, tokens: null, resyncConvexAuth: false });
          return null;
        }
        // Transient failure (network / 5xx after in-flight retries): keep the
        // session and the stored refresh token so a later forced refresh can
        // recover instead of signing the user out on a blip.
        logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
          "[convex-auth] Token refresh failed transiently, keeping session:",
          error,
        ]);
      }
      return token;
    });
  }

  const resolveOAuthInput = (input: URL | string | { code: string }) => {
    if (input instanceof URL) {
      return {
        code: input.searchParams.get("code"),
        cleanupUrl: input.searchParams.has("code")
          ? (() => {
              const next = new URL(input.toString());
              next.searchParams.delete("code");
              next.searchParams.delete("state");
              return next;
            })()
          : null,
      };
    }
    if (typeof input === "object") {
      return { code: input.code, cleanupUrl: null };
    }
    try {
      const url = new URL(input);
      return {
        code: url.searchParams.get("code"),
        cleanupUrl: url.searchParams.has("code")
          ? (() => {
              const next = new URL(url.toString());
              next.searchParams.delete("code");
              next.searchParams.delete("state");
              return next;
            })()
          : null,
      };
    } catch {
      return { code: input, cleanupUrl: null };
    }
  };

  const replaceWithCleanupUrl = async (cleanupUrl: URL) => {
    if (!runtime.location) return;
    const current = runtime.location.get();
    const relativeUrl =
      current !== null && cleanupUrl.origin === current.origin
        ? `${cleanupUrl.pathname}${cleanupUrl.search}${cleanupUrl.hash}`
        : cleanupUrl.toString();
    await runtime.location.replace(relativeUrl);
  };

  const completeOAuth = async (
    input: URL | string | { code: string },
  ): Promise<OAuthCompletionResult> => {
    const { code, cleanupUrl } = resolveOAuthInput(input);
    if (!code) {
      return { handled: false };
    }
    const result = await signIn(undefined, { code });
    if (result.kind !== "signedIn") {
      throw new Error("OAuth code exchange did not complete sign-in.");
    }
    if (cleanupUrl) {
      await replaceWithCleanupUrl(cleanupUrl);
    }
    return { handled: true, cleanupUrl };
  };

  const hydrateFromStorage = async () => {
    const storedToken = (await storageGet(JWT_STORAGE_KEY)) ?? null;
    await setToken({
      shouldStore: false,
      tokens: storedToken === null ? null : { token: storedToken as AccessToken },
      resyncConvexAuth: storedToken !== null && storedToken !== token,
    });
  };

  const initialize = async (): Promise<void> => {
    if (destroyed) return;
    if (initializePromise !== null) {
      return await initializePromise;
    }

    initializePromise = (async () => {
      if (proxy) {
        if (!tokenProvided && !hasServerToken && runtime.environment !== "server") {
          try {
            await fetchAccessToken({ forceRefreshToken: true });
          } catch (error) {
            logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
              "[convex-auth] Proxy token refresh failed:",
              error,
            ]);
          }
        }
        return;
      }

      // Only hydrate from storage when we did NOT already load a token
      // synchronously at boot (`readInitialToken`). With synchronous storage
      // (web localStorage) `hasServerToken` is already true, so re-reading is
      // redundant and can clobber a token a cross-tab sync adopted into memory
      // in the same tick; async-only storage (e.g. Expo SecureStore) returns
      // null synchronously, leaving `hasServerToken` false, and needs this.
      if (!tokenProvided && !hasServerToken) {
        try {
          await hydrateFromStorage();
        } catch {
          try {
            await setToken({ shouldStore: false, tokens: null, resyncConvexAuth: false });
          } catch {
            /* empty */
          }
        }
      }

      try {
        const loc = runtime.location?.get() ?? null;
        if (loc && loc.searchParams.has("code")) {
          await completeOAuth(loc);
        }
      } catch (error) {
        logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
          "[convex-auth] OAuth completion failed:",
          error,
        ]);
      }
    })();

    try {
      await initializePromise;
    } finally {
      initializePromise = Promise.resolve();
    }
  };

  const subscribe = (handler: AuthSubscriber): (() => void) => {
    let last: AuthState | null = null;
    const emit = () => {
      const state = publicSnapshot;
      if (last !== null && authStatesEqual(last, state)) {
        return;
      }
      last = state;
      handler(state);
    };
    emit();
    subscribers.add(emit);
    return () => {
      subscribers.delete(emit);
    };
  };

  if (!proxy && runtime.sync) {
    const logStorageSyncError = (error: unknown) => {
      logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
        "[convex-auth] Storage event handler failed:",
        error,
      ]);
    };
    disposeStorageListener =
      runtime.sync.subscribe(key(JWT_STORAGE_KEY), (value) => {
        if (destroyed) return;
        if (value === token) return;

        // Another tab signed out: propagate the sign-out here too.
        if (value === null) {
          void setToken({ shouldStore: false, tokens: null }).catch(logStorageSyncError);
          return;
        }

        const incoming = value as AccessToken;

        if (authConfirmed && token !== null) {
          // This tab holds a confirmed identity. Adopt a cross-tab token only
          // when it belongs to the SAME subject (a rotated access token) — and
          // do so without dropping confirmation, so a same-user rotation does
          // not flicker the UI through `loading`. A token for a DIFFERENT
          // subject is ignored to prevent one tab silently adopting another
          // user's identity.
          const currentSubject = decodeJwtSubject(token);
          const incomingSubject = decodeJwtSubject(incoming);
          if (currentSubject !== null && incomingSubject === currentSubject) {
            void setToken({
              shouldStore: false,
              tokens: { token: incoming },
              resyncConvexAuth: false,
            }).catch(logStorageSyncError);
          }
          return;
        }

        // This tab is signed out or still resolving: adopt a cross-tab sign-in
        // and run the confirmation handshake.
        void setToken({
          shouldStore: false,
          tokens: { token: incoming },
        }).catch(logStorageSyncError);
      }) ?? null;
  }

  bindConvexAuth();

  void initialize().catch((error) => {
    logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
      "[convex-auth] Client initialization failed:",
      error,
    ]);
    finalizeLoadingState();
  });

  const totp =
    adapters.totp ??
    createTotpClient({
      proxy,
      convex,
      requireApiRefs,
      proxyFetch,
      setTokenAndMaybeWait,
    });

  const device =
    adapters.device ??
    createDeviceClient({
      proxy,
      convex,
      requireApiRefs,
      proxyFetch,
      setTokenAndMaybeWait,
    });

  return {
    /** Restore persisted auth state for the current runtime. */
    initialize,
    /** SSR-safe URL param reader. */
    param,
    /** Pending invite from URL or recovered from storage. Null if none. */
    get invite(): PendingInvite | null {
      const pendingInvite = getPendingInvite();
      if (!pendingInvite) return null;
      return {
        token: pendingInvite.token,
        email: pendingInvite.email,
        accept: acceptInvite,
      };
    },
    /** Complete an OAuth callback from a URL or authorization code. */
    completeOAuth,
    /** Sign in with a provider. See {@link SignInResult} for return shape. */
    signIn,
    /** Sign out and clear all token state. */
    signOut,
    subscribe,
    getSnapshot: () => publicSnapshot,
    /** TOTP two-factor authentication helpers. */
    totp,
    /** Device authorization (RFC 8628) helpers. */
    device,
    /**
     * Tear down this auth client instance.
     *
     * Removes the cross-tab `storage` event listener, clears all
     * `subscribe` subscribers, and rejects any in-flight handshake
     * waiters. Call this when the client is no longer needed
     * (e.g. on SPA unmount or hot-module replacement) to prevent
     * memory leaks and stale callbacks.
     *
     * @example
     * ```ts
     * // SvelteKit onDestroy
     * import { onDestroy } from "svelte";
     * const auth = client({ convex, api: api.auth });
     * onDestroy(() => auth.destroy());
     * ```
     *
     * @example
     * ```ts
     * const unsubscribe = auth.subscribe((state) => console.log(state.status));
     *
     * // Later, during cleanup:
     * unsubscribe();
     * auth.destroy();
     * ```
     */
    destroy: () => {
      destroyed = true;
      clearDeauthGrace();
      // Reject ALL waiters, not just those at the current epoch — leftover
      // waiters from an earlier epoch would otherwise leak their timers and
      // never-settled promises across an unmount / hot-module replacement.
      rejectAllHandshakeWaiters(
        createHandshakeError("AUTH_HANDSHAKE_REJECTED", {
          reason: "destroyed",
        }),
      );
      disposeStorageListener?.();
      subscribers.clear();
    },
    ...(passkeyAdapter ? { passkey: passkeyAdapter } : {}),
  } as AuthClient<Api>;
}
