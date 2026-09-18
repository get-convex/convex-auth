// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import {
  AuthProvider,
  useAuth,
  usePendingSignInContext,
} from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import { useTotpSignInStep, type TotpSignInStepResult } from "./react.tsx";

// The code is verified with a plain Convex mutation, so the test substitutes
// the `useMutation` of `convex/react` for a mock of that call. Continuing the
// sign-in runs through the injected `AuthSignInApi`, stubbed separately.
const verify = vi.fn();
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useMutation: () => verify,
}));
const { signInApi, run: continueSignIn } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

const held = {
  status: "incomplete" as const,
  attemptToken: "attempt-1",
  expiresAt: 3_000,
  requirements: ["totp"],
};

// The mocks ignore the references, so any value will do.
const api = { verifyTotpForSignIn: {} as never, continueSignIn: {} as never };

async function renderStep({ holding = true } = {}) {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  const rendered = renderHook(
    () => ({
      auth: useAuth(),
      pending: usePendingSignInContext(),
      step: useTotpSignInStep(api),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect(rendered.result.current.auth.isLoading).toBe(false),
  );
  if (holding) {
    // A provider's sign-in hook would have adopted this.
    await act(() => rendered.result.current.pending.adopt(held));
  }
  return rendered;
}

describe("useTotpSignInStep", () => {
  afterEach(() => {
    verify.mockReset();
    continueSignIn.mockReset();
  });

  test("a verified code continues the sign-in, which adopts the session", async () => {
    verify.mockResolvedValue({ success: true });
    continueSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = await renderStep();

    let returned!: TotpSignInStepResult;
    await act(async () => {
      returned = await result.current.step.submit({ code: "123 456" });
    });

    expect(verify).toHaveBeenCalledWith({
      attemptToken: "attempt-1",
      code: "123 456",
      kind: undefined,
    });
    expect(continueSignIn).toHaveBeenCalledWith({ attemptToken: "attempt-1" });
    expect(returned).toEqual({ status: "complete" });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.pending.pendingSignIn).toBeNull();
  });

  test("a backup code reports how many remain", async () => {
    verify.mockResolvedValue({ success: true, remainingBackupCodes: 7 });
    continueSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = await renderStep();

    let returned!: TotpSignInStepResult;
    await act(async () => {
      returned = await result.current.step.submit({
        code: "abcd-efgh",
        kind: "backup",
      });
    });

    expect(verify).toHaveBeenCalledWith({
      attemptToken: "attempt-1",
      code: "abcd-efgh",
      kind: "backup",
    });
    expect(returned).toEqual({ status: "complete", remainingBackupCodes: 7 });
  });

  test("a wrong code is returned, and the sign-in stays pending for another try", async () => {
    verify.mockResolvedValue({
      success: false,
      userError: { error: "INVALID_CODE" },
    });
    const { result } = await renderStep();

    let returned!: TotpSignInStepResult;
    await act(async () => {
      returned = await result.current.step.submit({ code: "000000" });
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "INVALID_CODE" },
    });
    expect(continueSignIn).not.toHaveBeenCalled();
    expect(result.current.pending.pendingSignIn).toEqual(held);
    expect(result.current.pending.expired).toBe(false);
  });

  test("an expired attempt marks the pending sign-in expired", async () => {
    verify.mockResolvedValue({
      success: false,
      userError: { error: "SIGN_IN_EXPIRED" },
    });
    const { result } = await renderStep();

    let returned!: TotpSignInStepResult;
    await act(async () => {
      returned = await result.current.step.submit({ code: "123456" });
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "SIGN_IN_EXPIRED" },
    });
    expect(result.current.pending.pendingSignIn).toBeNull();
    expect(result.current.pending.expired).toBe(true);
  });

  test("a requirement still standing after the code is reported and held", async () => {
    verify.mockResolvedValue({ success: true });
    const next = { ...held, requirements: ["terms"] };
    continueSignIn.mockResolvedValue(next);
    const { result } = await renderStep();

    let returned!: TotpSignInStepResult;
    await act(async () => {
      returned = await result.current.step.submit({ code: "123456" });
    });

    expect(returned).toEqual({ status: "incomplete", requirements: ["terms"] });
    expect(result.current.pending.pendingSignIn).toEqual(next);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown verification folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    verify.mockRejectedValue(cause);
    const { result } = await renderStep();

    let returned!: TotpSignInStepResult;
    await act(async () => {
      returned = await result.current.step.submit({ code: "123456" });
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.pending.pendingSignIn).toEqual(held);
  });

  test("with no pending sign-in there is nothing to verify", async () => {
    const { result } = await renderStep({ holding: false });

    let returned!: TotpSignInStepResult;
    await act(async () => {
      returned = await result.current.step.submit({ code: "123456" });
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "SIGN_IN_EXPIRED" },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  test("pending is true through both calls and false after", async () => {
    let resolveVerify: (value: unknown) => void;
    verify.mockReturnValue(
      new Promise((resolve) => {
        resolveVerify = resolve;
      }),
    );
    let resolveContinue: (value: unknown) => void;
    continueSignIn.mockReturnValue(
      new Promise((resolve) => {
        resolveContinue = resolve;
      }),
    );
    const { result } = await renderStep();
    expect(result.current.step.pending).toBe(false);

    let submitted: Promise<unknown>;
    act(() => {
      submitted = result.current.step.submit({ code: "123456" });
    });
    await waitFor(() => expect(result.current.step.pending).toBe(true));

    await act(async () => {
      resolveVerify!({ success: true });
    });
    expect(result.current.step.pending).toBe(true);

    await act(async () => {
      resolveContinue!({ status: "complete", tokens: bundle });
      await submitted;
    });
    expect(result.current.step.pending).toBe(false);
  });
});
