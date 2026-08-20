// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { useAuthToken } from "../../react/index.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import { SignInAnonymousMutation, useAnonymousAuth } from "./react.tsx";

// The hook runs its sign-in mutation through the injected `AuthSignInApi`, so the
// test substitutes a signInApi rather than mocking `convex/react`.
const { signInApi, run: runSignIn } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// A stand-in for the app's `api.auth.signInAnonymous` reference. The stub signInApi
// ignores it, so any value typed as the reference will do.
const signInAnonymous = {} as SignInAnonymousMutation;

function renderAnonymousAuth() {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  return renderHook(
    () => ({
      auth: useAuth(),
      token: useAuthToken(),
      anonymous: useAnonymousAuth(signInAnonymous),
    }),
    { wrapper },
  );
}

describe("useAnonymousAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runSignIn.mockReset();
  });

  test("signIn adopts the envelope's bundle from signInAnonymous into the core client", async () => {
    runSignIn.mockResolvedValue({ success: true, tokens: bundle });
    const { result } = renderAnonymousAuth();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);

    await act(async () => {
      await result.current.anonymous.signInAnonymous();
    });

    expect(runSignIn).toHaveBeenCalledTimes(1);
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });
});
