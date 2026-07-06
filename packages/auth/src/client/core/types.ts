import type { FunctionReference } from "convex/server";
import type { ConvexError, Value } from "convex/values";

import type { AccessToken } from "../../shared/brand";
import type { AuthTokens, SignInFlowResult } from "../../shared/results";
import type { ErrorCode } from "../../shared/codes";

/**
 * Structural interface for any Convex client.
 * Satisfied by `ConvexClient` (`convex/browser`),
 * `ConvexReactClient` (`convex/react`), and similar transports.
 *
 * `clearAuth` is present on `ConvexReactClient` and `BaseConvexClient`
 * but not on the simplified `ConvexClient`. When available we call it
 * during sign-out for a clean deauthentication.
 */
export interface ConvexTransport {
  action(action: unknown, args: unknown): Promise<unknown>;
  setAuth(
    fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>,
    onChange?: (isAuthenticated: boolean) => void,
  ): void;
  clearAuth?(): void;
}

/** Minimal action-only transport used for unauthenticated auth flows. */
export interface ActionTransport {
  action(action: unknown, args: unknown): Promise<unknown>;
}

/** @internal */
export type SignInApiRef = { signIn: AuthApiRefs["signIn"] };

/** Pluggable key-value storage supplied by the host runtime. */
export interface Storage {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Platform-neutral location/navigation hooks. */
interface LocationRuntime {
  get(): URL | null;
  replace(relativeUrl: string): void | Promise<void>;
}

/**
 * Platform-specific OAuth launch primitive.
 *
 * `open` receives the provider authorization URL. Platforms that navigate the
 * whole page away (browser) return nothing; platforms that run the flow in an
 * in-app session (Expo) return the callback URL so the core can complete the
 * exchange inline.
 */
interface OAuthRuntime {
  open(url: URL): void | string | URL | Promise<void | string | URL>;
}

/** Cross-context synchronization hooks, such as browser storage events. */
interface SyncRuntime {
  subscribe(
    key: string,
    callback: (value: string | null) => void | Promise<void>,
  ): (() => void) | null;
}

/** Cross-context mutex/locking primitive. */
interface MutexRuntime {
  withKey<T>(key: string, callback: () => Promise<T>): Promise<T>;
}

/** Proxy request execution supplied by the host runtime. */
interface ProxyRuntime {
  fetch(body: Record<string, unknown>, proxyPath: string): Promise<Response>;
}

/**
 * Platform-neutral client runtime dependencies.
 *
 * The core `client` package should depend only on these interfaces, while the
 * browser package can provide concrete implementations backed by DOM APIs.
 */
export interface ClientRuntime {
  environment?: "client" | "server";
  storage?: Storage | null;
  location?: LocationRuntime;
  oauth?: OAuthRuntime;
  sync?: SyncRuntime;
  mutex?: MutexRuntime;
  proxy?: ProxyRuntime;
}

/** Platform-specific factor adapters injected by entrypoints like `browser`. */
export interface ClientAdapters {
  passkey?: PasskeyClient;
  totp?: TotpClient;
  device?: DeviceClient;
}

/**
 * Shared dependencies threaded into every factor client (`totp`, `device`,
 * `passkey`). The core `client` builds one of these and passes it to each
 * factor factory.
 *
 * @internal
 */
export interface FactorDeps {
  proxy: string | undefined;
  convex: ConvexTransport;
  requireApiRefs: () => SignInApiRef;
  proxyFetch: (body: Record<string, unknown>) => Promise<unknown>;
  setTokenAndMaybeWait: (
    args:
      | {
          shouldStore: true;
          tokens: AuthTokens | null;
          waitForHandshake: boolean;
          context: { provider?: string; flow: string };
        }
      | {
          shouldStore: false;
          tokens: { token: AccessToken } | null;
          waitForHandshake: boolean;
          context: { provider?: string; flow: string };
        },
  ) => Promise<boolean>;
}

/**
 * Dependencies provided to platform-specific factor adapters.
 *
 * @internal
 */
export type ClientAdapterDeps = FactorDeps;

/**
 * Factory overrides for platform-specific factor adapters.
 *
 * @internal
 */
export interface ClientAdapterFactories {
  passkey?: (deps: ClientAdapterDeps) => PasskeyClient;
}

/** @internal */
export type SignInActionResult = SignInFlowResult<AuthTokens | null>;

/**
 * Device authorization payload returned from the `deviceCode` sign-in flow.
 */
export type DeviceCodeResult = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

/**
 * Result of a `signIn` call.
 *
 * - `kind: "signedIn"` — credentials were accepted and a client session is now available.
 * - `kind: "redirect"` — OAuth flow initiated; redirect the user to `redirect.toString()`.
 * - `kind: "totpRequired"` — credentials valid but 2FA is needed; call `auth.totp.verify()`.
 * - `kind: "deviceCode"` — device flow initiated; display the code and poll via `auth.device.poll()`.
 * - `kind: "started"` — a non-immediate flow started (for example email/phone verification).
 * - `kind: "failed"` — the flow did not complete; `code` is the typed {@link ErrorCode}.
 *
 * @see {@link AuthState}
 */
export type SignInResult =
  | { kind: "signedIn" }
  | { kind: "redirect"; redirect: URL; verifier: string }
  | { kind: "totpRequired"; verifier: string }
  | { kind: "deviceCode"; deviceCode: DeviceCodeResult }
  | { kind: "started" }
  | { kind: "failed"; code: ErrorCode };

/** @internal */
export type AuthSnapshot = {
  phase: "loading" | "handshake" | "authenticated" | "unauthenticated";
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
};

/** Reactive auth state. `token` is non-null only after Convex confirms auth. */
export type AuthState =
  | { status: "loading"; token: null }
  | { status: "signedOut"; token: null }
  | { status: "signedIn"; token: string };

/** Handler for `auth.subscribe`. */
export type AuthSubscriber = (state: AuthState) => void;

/**
 * Typed Convex API references for the auth functions.
 * Pass these from your generated `api` object.
 *
 * @typeParam HasPasskey - Whether the passkey provider is configured.
 * @typeParam HasTotp - Whether the TOTP provider is configured.
 * @typeParam HasDevice - Whether the device provider is configured.
 */
export type AuthApiRefs<
  HasPasskey extends boolean = boolean,
  HasTotp extends boolean = boolean,
  HasDevice extends boolean = boolean,
> = {
  signIn: FunctionReference<"action", "public", Record<string, Value>, unknown>;
  signOut: FunctionReference<"action", "public", Record<string, Value>, unknown>;
  /** @internal Set automatically by `defineAuth` — do not set manually. */
  _capabilities?: {
    passkey: HasPasskey;
    totp: HasTotp;
    device: HasDevice;
  };
};

/**
 * Optional hints for {@link PasskeyClient.register}.
 */
export type PasskeyRegisterOptions = {
  /** Human-readable label for this credential (e.g. `"MacBook Pro"`). */
  name?: string;
  /** Email hint stored with the credential. */
  email?: string;
  /** WebAuthn `user.name` override. */
  userName?: string;
  /** WebAuthn `user.displayName` override. */
  userDisplayName?: string;
};

/**
 * Optional hints for {@link PasskeyClient.signIn}.
 */
export type PasskeySignInOptions = {
  /** Email hint to filter discoverable credentials. */
  email?: string;
  /** Set to `true` for conditional UI (autofill) mode. */
  autofill?: boolean;
};

/**
 * Passkey (WebAuthn) client-side helpers.
 *
 * @see {@link TotpClient}
 * @see {@link DeviceClient}
 */
export interface PasskeyClient {
  /**
   * Check whether the current runtime exposes WebAuthn passkey APIs.
   *
   * @returns `true` when `navigator.credentials` is available.
   *
   * @example
   * ```ts
   * if (auth.passkey.isSupported()) {
   *   // Show passkey registration button
   * }
   * ```
   */
  isSupported(): boolean;

  /**
   * Check whether conditional mediation (autofill-style passkeys) is available.
   *
   * @returns `true` when the browser supports `PublicKeyCredential.isConditionalMediationAvailable`.
   *
   * @example
   * ```ts
   * if (await auth.passkey.isAutofillSupported()) {
   *   await auth.passkey.signIn({ autofill: true });
   * }
   * ```
   */
  isAutofillSupported(): Promise<boolean>;

  /**
   * Start a passkey registration flow and complete the WebAuthn ceremony.
   *
   * Creates a new credential bound to the current user's account.
   *
   * @param opts - Optional registration hints.
   * @param opts.name - Human-readable name for the passkey (e.g. `"MacBook Pro"`).
   * @param opts.email - Email hint for discoverable credentials.
   * @param opts.userName - WebAuthn `user.name` override.
   * @param opts.userDisplayName - WebAuthn `user.displayName` override.
   * @returns A {@link SignInResult} — typically `{ kind: "signedIn" }` once a client session is available.
   *
   * @example
   * ```ts
   * const result = await auth.passkey.register({ name: "My laptop" });
   * ```
   */
  register(opts?: PasskeyRegisterOptions): Promise<SignInResult>;

  /**
   * Sign in with an existing passkey and complete the WebAuthn ceremony.
   *
   * @param opts - Optional sign-in hints.
   * @param opts.email - Email hint to filter discoverable credentials.
   * @param opts.autofill - Set to `true` for conditional UI (autofill) mode.
   * @returns A {@link SignInResult} — typically `{ kind: "signedIn" }` once a client session is available.
   *
   * @example
   * ```ts
   * const result = await auth.passkey.signIn();
   * ```
   */
  signIn(opts?: PasskeySignInOptions): Promise<SignInResult>;
}

/**
 * Optional hints for {@link TotpClient.setup}.
 */
export type TotpSetupOptions = {
  /** Issuer name shown in the authenticator app. */
  name?: string;
  /** Account label shown in the authenticator app. */
  accountName?: string;
};

/** Result of {@link TotpClient.setup}. */
export type TotpSetupResult = {
  /** `otpauth://` URL — render as a QR code. */
  uri: string;
  /** Raw base32-encoded shared secret. */
  secret: string;
  /** Verifier token to pass to {@link TotpClient.confirm}. */
  verifier: string;
  /** Factor ID to pass to {@link TotpClient.confirm}. */
  totpId: string;
};

/** Params for {@link TotpClient.confirm}. */
export type TotpConfirmParams = {
  /** Six-digit OTP from the authenticator app. */
  code: string;
  /** Verifier token from {@link TotpSetupResult.verifier}. */
  verifier: string;
  /** Factor ID from {@link TotpSetupResult.totpId}. */
  totpId: string;
};

/** Params for {@link TotpClient.verify}. */
export type TotpVerifyParams = {
  /** Six-digit OTP from the authenticator app. */
  code: string;
  /** Verifier token from a `totpRequired` sign-in result. */
  verifier: string;
};

/**
 * TOTP two-factor authentication client-side helpers.
 *
 * @see {@link PasskeyClient}
 * @see {@link DeviceClient}
 */
export interface TotpClient {
  /**
   * Start TOTP enrollment and return the setup URI, secret, verifier, and factor ID.
   *
   * The returned `uri` is an `otpauth://` URL that can be rendered as a QR code
   * for the user to scan with their authenticator app.
   *
   * @param opts - Optional setup hints.
   * @param opts.name - Issuer name shown in the authenticator app.
   * @param opts.accountName - Account label in the authenticator app.
   * @returns An object with `{ uri, secret, verifier, totpId }`.
   *
   * @example
   * ```ts
   * const { uri, secret, verifier, totpId } = await auth.totp.setup();
   * // Render `uri` as a QR code, then confirm:
   * await auth.totp.confirm({ code: userCode, verifier, totpId });
   * ```
   */
  setup(opts?: TotpSetupOptions): Promise<TotpSetupResult>;

  /**
   * Confirm a newly created TOTP factor with the first authenticator code.
   *
   * Call this after the user scans the QR code and enters the first OTP.
   *
   * @param opts - Confirmation parameters.
   * @param opts.code - The 6-digit TOTP code from the authenticator app.
   * @param opts.verifier - The verifier string returned by {@link TotpClient.setup}.
   * @param opts.totpId - The factor ID returned by {@link TotpClient.setup}.
   * @returns A {@link SignInResult} — `{ kind: "signedIn" }` on success, or
   *   `{ kind: "failed", code }` when the code is rejected.
   *
   * @example
   * ```ts
   * const result = await auth.totp.confirm({ code: "123456", verifier, totpId });
   * if (result.kind === "failed") showError(result.code);
   * ```
   */
  confirm(opts: TotpConfirmParams): Promise<SignInResult>;

  /**
   * Complete a sign-in that is waiting on TOTP verification.
   *
   * Called when `signIn()` returns `{ kind: "totpRequired" }`.
   *
   * @param opts - Verification parameters.
   * @param opts.code - The 6-digit TOTP code from the authenticator app.
   * @param opts.verifier - The verifier string from the `totpRequired` result.
   * @returns A {@link SignInResult} — `{ kind: "signedIn" }` on success, or
   *   `{ kind: "failed", code }` when the code is rejected.
   *
   * @example
   * ```ts
   * const result = await auth.signIn("password", { email, password });
   * if (result.kind === "totpRequired") {
   *   const totp = await auth.totp.verify({ code: totpCode, verifier: result.verifier });
   *   if (totp.kind === "failed") showError(totp.code);
   * }
   * ```
   */
  verify(opts: TotpVerifyParams): Promise<SignInResult>;
}

/** Params for {@link DeviceClient.poll}. */
export type DevicePollParams = {
  code: DeviceCodeResult;
  /** Aborts the poll loop cleanly, e.g. on UI unmount. */
  signal?: AbortSignal;
};

/** Params for {@link DeviceClient.verify}. */
export type DeviceVerifyParams = { code: string };

/**
 * Device authorization (RFC 8628) client-side helpers.
 *
 * @see {@link PasskeyClient}
 * @see {@link TotpClient}
 */
export interface DeviceClient {
  /**
   * Poll until a device flow is approved or expires.
   *
   * Polls the server at the interval specified in the {@link DeviceCodeResult}
   * until the user authorizes the device or the code expires.
   *
   * @param opts - Poll options.
   * @param opts.code - The {@link DeviceCodeResult} returned from `signIn("device")`.
   * @param opts.signal - Optional {@link AbortSignal}; aborting returns cleanly
   *   at the next loop boundary (e.g. on UI unmount).
   * @throws `ConvexError({ code: "DEVICE_CODE_EXPIRED" })` when the code expires before authorization.
   *
   * @example
   * ```ts
   * const controller = new AbortController();
   * const result = await auth.signIn("device");
   * if (result.kind === "deviceCode") {
   *   // Display result.deviceCode.userCode to the user
   *   await auth.device.poll({ code: result.deviceCode, signal: controller.signal });
   *   console.log("Device authorized!");
   * }
   * ```
   */
  poll(opts: DevicePollParams): Promise<void>;

  /**
   * Approve a device flow from the verification page using the displayed user code.
   *
   * Call this on the authorization page where the user enters the short code
   * shown on the device screen.
   *
   * @param opts - Verification options.
   * @param opts.code - The user code string (e.g. `"WDJB-MJHT"`).
   * @throws `ConvexError({ code: "DEVICE_AUTHORIZATION_FAILED" })` when verification fails.
   *
   * @example
   * ```ts
   * await auth.device.verify({ code: "WDJB-MJHT" });
   * ```
   */
  verify(opts: DeviceVerifyParams): Promise<void>;
}

/**
 * Extract capability flags from an AuthApiRefs type.
 *
 * @typeParam Api - An AuthApiRefs type to extract capability flags from.
 */
type InferCaps<Api extends AuthApiRefs<boolean, boolean, boolean>> =
  Api extends AuthApiRefs<infer P, infer T, infer D>
    ? { passkey: P; totp: T; device: D }
    : { passkey: boolean; totp: boolean; device: boolean };

/** Pending invite detected from URL or recovered from storage after redirect. */
export interface PendingInvite {
  /**
   * Raw one-time invite token. Pass to your invite acceptance mutation.
   * @readonly
   */
  readonly token: string;
  /**
   * Invite email from the URL or stored redirect state, if available.
   * @readonly
   */
  readonly email: string | null;
  /**
   * Consume the invite: clears storage/URL params and returns the token.
   *
   * @returns The invite token.
   * @throws When there is no pending invite to accept.
   */
  accept(): Promise<{ token: string }>;
}

/**
 * Discriminated union of params for the password provider's flows.
 *
 * Each branch maps to one of the five password flows: `signUp`, `signIn`,
 * `reset`, `verify`, `change`. Selecting a `flow` literal narrows the
 * accepted params automatically.
 */
export type PasswordParams =
  | { flow: "signUp"; email: string; password: string; redirectTo?: string }
  | { flow: "signIn"; email: string; password: string; redirectTo?: string }
  | { flow: "reset"; email: string; redirectTo?: string }
  | {
      flow: "verify";
      email: string;
      code: string;
      /** When set, completes a `reset` flow by updating the password. Otherwise confirms email. */
      newPassword?: string;
      redirectTo?: string;
    }
  | {
      flow: "change";
      email: string;
      currentPassword: string;
      newPassword: string;
      redirectTo?: string;
    };

/** Params for the email (magic link) provider's initiation step. */
export type EmailInitiateParams = { email: string; redirectTo?: string };

/**
 * Params for completing a code-based flow (no provider). Used to finalise
 * email magic-link sign-ins and password-reset OTPs when the verification
 * call is made without re-specifying the originating provider.
 */
export type CodeCompletionParams = { code: string; redirectTo?: string };

/** Params for the `connection` provider — requires a connection ID. */
export type ConnectionParams = { connectionId: string; redirectTo?: string };

/** Params for the anonymous provider. Empty / `redirectTo` only. */
export type AnonymousParams = { redirectTo?: string };

/** Default params shape for OAuth-style providers (google, github, etc.). */
export type OAuthSignInParams = { redirectTo?: string };

/**
 * Params for `signIn("passkey", ...)`. Direct passkey flows are typically
 * triggered through `auth.passkey.register()` / `auth.passkey.signIn()`
 * — this overload is for advanced callers that bypass the helper.
 */
export type PasskeySignInParams = { redirectTo?: string };

/**
 * Resolves the `params` argument shape from the `provider` literal.
 *
 * Known special providers (`"password"`, `"email"`, etc.) get strict typing.
 * Any other string falls back to OAuth-style params, since custom OAuth
 * providers can be registered under arbitrary IDs.
 */
export type ParamsForProvider<P> = P extends "password"
  ? PasswordParams
  : P extends "email"
    ? EmailInitiateParams
    : P extends "anonymous"
      ? AnonymousParams | undefined
      : P extends "connection"
        ? ConnectionParams
        : P extends "passkey"
          ? PasskeySignInParams | undefined
          : P extends undefined
            ? CodeCompletionParams
            : OAuthSignInParams | undefined;

/**
 * Tuple-rest helper that flips `params` between required and optional based
 * on whether `undefined` is in its resolved type.
 *
 * @internal
 */
export type SignInArgs<P> =
  undefined extends ParamsForProvider<P>
    ? [params?: ParamsForProvider<P>]
    : [params: ParamsForProvider<P>];

/**
 * Public signature for `auth.signIn`. The provider literal discriminates the
 * params shape via {@link ParamsForProvider}, and the params slot is
 * automatically optional when the resolved type permits `undefined`.
 *
 * @example
 * ```ts
 * auth.signIn("password", { flow: "signIn", email, password });
 * auth.signIn("password", { flow: "change", email, currentPassword, newPassword });
 * auth.signIn("anonymous"); // params optional
 * ```
 */
export type SignInOverloads = <P extends string | undefined>(
  provider: P,
  ...args: SignInArgs<P>
) => Promise<SignInResult>;

/**
 * Internal-only loose signature for the `signIn` value. Use this when
 * forwarding through wrappers where TypeScript cannot select an overload
 * from the wrapper's union-typed `provider` argument.
 *
 * @internal
 */
export type SignInImpl = (
  provider?: string,
  params?: Record<string, unknown>,
) => Promise<SignInResult>;

/** Base auth client — always present. */
interface AuthClientBase {
  /** Restore initial auth state for the current runtime. */
  initialize: () => Promise<void>;
  /** SSR-safe query-param reader. */
  param: (name: string) => string | null;
  /**
   * Pending invite recovered from the URL or storage, if present.
   * @readonly
   */
  readonly invite: PendingInvite | null;
  /** Complete an OAuth callback using a URL or authorization code. */
  completeOAuth: (input: URL | string | { code: string }) => Promise<OAuthCompletionResult>;
  /** Start a sign-in flow for a provider. */
  signIn: SignInOverloads;
  /** Sign out and clear local auth state. */
  signOut: () => Promise<void>;
  /** Subscribe to auth state changes; returns an unsubscribe. */
  subscribe: (handler: AuthSubscriber) => () => void;
  /** Read the current auth state synchronously, e.g. for `useSyncExternalStore`. */
  getSnapshot: () => AuthState;
  /** Tear down listeners and reject in-flight handshakes. */
  destroy: () => void;
}

/**
 * Framework-agnostic auth client return type.
 *
 * Conditionally includes `totp` and `device` helpers based on the
 * capabilities in the `AuthApiRefs` type. Platform-specific `passkey` helpers
 * are added by {@link PlatformAuthClient}.
 *
 * @typeParam Api - An AuthApiRefs type that determines which factor helpers are included.
 */
export type AuthClient<Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs> =
  AuthClientBase &
    (InferCaps<Api>["totp"] extends true ? { totp: TotpClient } : {}) &
    (InferCaps<Api>["device"] extends true ? { device: DeviceClient } : {});

/**
 * Browser auth client return type.
 *
 * Extends {@link AuthClient} with conditional passkey helpers when the
 * generated auth API exposes passkey capabilities.
 *
 * @typeParam Api - An AuthApiRefs type that determines which factor helpers are included.
 */
export type PlatformAuthClient<Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs> =
  AuthClient<Api> & (InferCaps<Api>["passkey"] extends true ? { passkey: PasskeyClient } : {});

/** @deprecated Use `PlatformAuthClient`. */
export type BrowserAuthClient<Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs> =
  PlatformAuthClient<Api>;

/**
 * Options for {@link client}.
 *
 * @typeParam Api - An AuthApiRefs type.
 */
export type ClientOptions<Api extends AuthApiRefs<boolean, boolean, boolean> = AuthApiRefs> = {
  /** Any Convex client implementation used to run auth actions. */
  convex: ConvexTransport;
  /** Platform runtime implementation used by the client core. */
  runtime?: ClientRuntime;
  /** Platform-specific factor adapters supplied by higher-level entrypoints. */
  adapters?: ClientAdapters;
  /** Platform-specific adapter factories supplied by higher-level entrypoints. */
  adapterFactories?: ClientAdapterFactories;
  /**
   * Typed auth function refs from your generated `api` object.
   * Required outside proxy mode.
   */
  api?: Api;
  /** Explicit Convex deployment URL when it cannot be inferred from the client. */
  url?: string;
  /**
   * Optional action-only transport for direct code exchange outside proxy mode.
   * Required in non-browser runtimes when `proxyPath` is not set.
   */
  httpClient?: ActionTransport | null;
  /**
   * Storage backend for persisted tokens.
   *
   * Defaults to `runtime.storage` when provided, otherwise `null`.
   */
  storage?: Storage | null;
  /**
   * Server-known auth used to seed the synchronous boot so SSR and hydration
   * render the resolved state on first paint. A non-empty JWT boots signed in;
   * `null` boots signed out. Providing this at all marks auth as resolved, so
   * the client skips the loading phase. Omit it (leave `undefined`) to read the
   * persisted value from `storage` instead. Ongoing persistence always uses
   * `storage`.
   */
  token?: string | null;
  /**
   * Proxy endpoint used instead of direct Convex auth calls.
   * When set, provide `runtime.proxy` and omit direct `api`/`httpClient`
   * transport requirements.
   */
  proxyPath?: string;
  /** SSR-safe URL source for reading query parameters. */
  location?: URL | (() => URL | null);
  /**
   * Default OAuth `redirectTo` applied to `signIn` calls that omit it. Platform
   * entrypoints set this (e.g. Expo passes its native redirect URI) so the core
   * can build the authorization URL without a platform-specific `signIn` wrapper.
   */
  oauthRedirectTo?: string;
  /**
   * Milliseconds to wait for the Convex client to confirm a new token
   * before a sign-in handshake rejects with `AUTH_HANDSHAKE_TIMEOUT`.
   * Defaults to `5000`.
   */
  handshakeTimeoutMs?: number;
};

export type OAuthCompletionResult = { handled: false } | { handled: true; cleanupUrl: URL | null };

/**
 * Metadata describing the current auth flow for handshake diagnostics.
 *
 * @internal
 */
export type AuthFlowContext = {
  provider?: string;
  flow: string;
};

/**
 * A simple deferred promise that can be resolved or rejected externally.
 */
interface SimpleDeferred<T, E = unknown> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: E): void;
}

/**
 * Create a deferred promise that can be resolved or rejected externally.
 *
 * @returns A deferred object containing the promise and control methods.
 * @internal
 */
export function createDeferred<T, E = unknown>(): SimpleDeferred<T, E> {
  let resolve!: (value: T) => void;
  let reject!: (error: E) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej as (error: E) => void;
  });
  return { promise, resolve, reject };
}

/** @internal */
export type HandshakeWaiter = {
  epoch: number;
  context: AuthFlowContext;
  deferred: SimpleDeferred<void, ConvexError<Value>>;
  timeoutId: ReturnType<typeof setTimeout>;
};
