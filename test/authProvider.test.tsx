// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/react/client";

afterEach(cleanup);

function createMockStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

function AuthStateDisplay() {
  const { isLoading, isAuthenticated } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
    </div>
  );
}

function setWindowLocation(url: string) {
  const original = window.location;
  Object.defineProperty(window, "location", {
    value: new URL(url),
    configurable: true,
  });
  return () => {
    Object.defineProperty(window, "location", {
      value: original,
      configurable: true,
    });
  };
}

// StrictMode double-fires effects, which is how this regression manifests:
// the first effect run starts sign-in, then the second run hits the else
// branch and calls readStateFromStorage(), setting isLoading=false prematurely.
test("isLoading stays true while URL code sign-in is in flight (StrictMode)", async () => {
  const restore = setWindowLocation(
    "http://localhost:3000/?code=test-oauth-code",
  );

  let resolveSignIn!: (value: any) => void;
  const signInPromise = new Promise((resolve) => {
    resolveSignIn = resolve;
  });

  const mockClient = {
    authenticatedCall: vi.fn(() => signInPromise),
    unauthenticatedCall: vi.fn(),
    verbose: undefined,
  };

  render(
    <React.StrictMode>
      <AuthProvider
        client={mockClient as any}
        storage={createMockStorage()}
        storageNamespace="test"
        replaceURL={vi.fn()}
      >
        <AuthStateDisplay />
      </AuthProvider>
    </React.StrictMode>,
  );

  // Sign-in is in flight — isLoading must remain true.
  // The 0.0.90 regression caused isLoading to flip false here because
  // StrictMode re-ran the effect and readStateFromStorage() was called.
  //
  // readStateFromStorage is async (uses await), so we verify isLoading
  // does NOT become false. waitFor polls for up to 200ms — if the bug
  // is present the inner assertion succeeds and the test fails.
  const isLoadingBecameFalse = await waitFor(
    () => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
      return true;
    },
    { timeout: 200 },
  ).catch(() => false);
  expect(isLoadingBecameFalse).toBe(false);
  expect(screen.getByTestId("authenticated").textContent).toBe("false");

  // Complete the sign-in
  resolveSignIn({
    tokens: { token: "fake-jwt", refreshToken: "fake-refresh" },
  });

  await waitFor(() => {
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("authenticated").textContent).toBe("true");
  });

  restore();
});

test("isLoading resolves when shouldHandleCode is false", async () => {
  const restore = setWindowLocation("http://localhost:3000/?code=some-code");

  const mockClient = {
    authenticatedCall: vi.fn(),
    unauthenticatedCall: vi.fn(),
    verbose: undefined,
  };

  render(
    <AuthProvider
      client={mockClient as any}
      storage={createMockStorage()}
      storageNamespace="test"
      replaceURL={vi.fn()}
      shouldHandleCode={false}
    >
      <AuthStateDisplay />
    </AuthProvider>,
  );

  // Should fall through to readStateFromStorage, not hang
  await waitFor(() => {
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  // Should NOT have attempted sign-in
  expect(mockClient.authenticatedCall).not.toHaveBeenCalled();
  expect(screen.getByTestId("authenticated").textContent).toBe("false");

  restore();
});
