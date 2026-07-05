import { useCallback, useSyncExternalStore } from "react";
import { generateToken, hashToken } from "@convex-dev/auth/lib/crypto.js";
import { api } from "../convex/_generated/api";
import { convex, convexSiteUrl } from "./client";

/**
 * The smallest client-side session plumbing for the auth components: a
 * localStorage-backed token store, the OAuth entry/exit points, and the
 * `useAuth` hook `ConvexProviderWithAuth` consumes. A future
 * `@convex-dev/auth` React client will own this; the example hand-rolls it to
 * show exactly what the wiring involves.
 */

/** The session a sign-in mints, as returned by the backend. */
export type TokenBundle = {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  userId: string;
};

const STORAGE_KEY = "convexAuthSession";

// Refresh slightly before the access token actually expires.
const ACCESS_TOKEN_LEEWAY_MS = 10_000;

function readStoredSession(): TokenBundle | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as TokenBundle;
  } catch {
    return null;
  }
}

// --- A tiny module-level session store -------------------------------------
//
// The session is read from three places (the provider's useAuth hook, the
// app's UI, and imperative helpers like signOut), so it lives outside React
// with a subscription hook over it.

let session: TokenBundle | null = readStoredSession();
const listeners = new Set<() => void>();

function setSession(next: TokenBundle | null): void {
  session = next;
  if (next === null) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  for (const notify of listeners) {
    notify();
  }
}

/** The current session, updating as sign-in/refresh/sign-out change it. */
export function useSession(): TokenBundle | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => session,
  );
}

// --- OAuth flow entry/exit ---------------------------------------------------

// The verifier that binds an in-flight OAuth flow to this browser. Minted at
// flow start, its hash travels through the flow as the `challenge`, and
// redeeming the resulting one-time code demands the verifier itself back — so
// a code landed in any *other* browser (a link a victim was tricked into
// opening) can't become a session.
const VERIFIER_STORAGE_KEY = "convexAuthOAuthVerifier";

/**
 * Start a provider's flow: mint and store the flow verifier, then navigate to
 * the component-hosted `/start` route. That's the entire "sign in with …"
 * implementation — the component 302s to the provider and, on the way back,
 * redirects to `SITE_URL<redirectTo>?code=…`.
 */
export async function startOAuth(
  provider: "google" | "github",
  redirectTo = "/",
): Promise<void> {
  const verifier = generateToken();
  localStorage.setItem(VERIFIER_STORAGE_KEY, verifier);
  const url = new URL(`/auth/${provider}/start`, convexSiteUrl);
  url.searchParams.set("redirectTo", redirectTo);
  url.searchParams.set("challenge", await hashToken(verifier));
  window.location.assign(url.toString());
}

/**
 * Exchange the one-time `?code=` the OAuth callback redirected back with,
 * plus the verifier stored when the flow started, for a session. Throws
 * (leaving no session) when the code is invalid — expired, replayed, or
 * forged — or when this browser never started a flow.
 */
export async function redeemOAuthCode(code: string): Promise<void> {
  const verifier = localStorage.getItem(VERIFIER_STORAGE_KEY);
  localStorage.removeItem(VERIFIER_STORAGE_KEY);
  if (verifier === null) {
    throw new Error("No sign-in flow was started from this browser.");
  }
  const bundle = await convex.mutation(api.auth.redeemOAuthCode, {
    code,
    verifier,
  });
  setSession(bundle);
}

/** End the session locally and revoke it on the server. */
export async function signOut(): Promise<void> {
  const current = session;
  setSession(null);
  if (current !== null) {
    await convex.mutation(api.auth.signOut, {
      refreshToken: current.refreshToken,
    });
  }
}

// --- ConvexProviderWithAuth integration -------------------------------------

/**
 * The `useAuth` implementation for `ConvexProviderWithAuth`: serves the
 * stored access token while it's fresh and rotates the session via
 * `refreshSession` when it isn't (or when the server demands a fresh token).
 * A failed refresh clears the session, which flows back into the provider as
 * signed-out.
 */
export function useAuthFromSession(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args: {
    forceRefreshToken: boolean;
  }) => Promise<string | null>;
} {
  const current = useSession();

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const live = session;
      if (live === null) {
        return null;
      }
      const freshUntil = Date.now() + ACCESS_TOKEN_LEEWAY_MS;
      if (!forceRefreshToken && live.accessTokenExpiresAt > freshUntil) {
        return live.accessToken;
      }
      const refreshed = await convex.mutation(api.auth.refreshSession, {
        refreshToken: live.refreshToken,
      });
      setSession(refreshed);
      return refreshed?.accessToken ?? null;
    },
    [],
  );

  return {
    isLoading: false,
    isAuthenticated: current !== null,
    fetchAccessToken,
  };
}
