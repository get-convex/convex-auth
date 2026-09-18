// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  useVerifyTotpForSignIn,
  type VerifyTotpForSignInHookResult,
} from "./react.tsx";

// The hook runs a plain Convex mutation, so the test substitutes the
// `useMutation` of `convex/react` for a mock of the call.
const run = vi.fn();
vi.mock("convex/react", () => ({ useMutation: () => run }));

// The mock ignores the reference, so any value will do.
const mutation = {} as never;
const args = { attemptToken: "attempt-1", code: "123 456" };

describe("useVerifyTotpForSignIn", () => {
  afterEach(() => {
    run.mockReset();
  });

  test("passes the arguments up and returns the result as it is", async () => {
    run.mockResolvedValue({ success: true, remainingBackupCodes: 7 });
    const { result } = renderHook(() => useVerifyTotpForSignIn(mutation));

    let returned!: VerifyTotpForSignInHookResult;
    await act(async () => {
      returned = await result.current.verify({ ...args, kind: "backup" });
    });

    expect(run).toHaveBeenCalledWith({ ...args, kind: "backup" });
    expect(returned).toEqual({ success: true, remainingBackupCodes: 7 });
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    run.mockRejectedValue(cause);
    const { result } = renderHook(() => useVerifyTotpForSignIn(mutation));

    let returned!: VerifyTotpForSignInHookResult;
    await act(async () => {
      returned = await result.current.verify(args);
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("pending is true while in flight and false after", async () => {
    let resolveMutation: (value: unknown) => void;
    run.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = renderHook(() => useVerifyTotpForSignIn(mutation));
    expect(result.current.pending).toBe(false);

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.verify(args);
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    await act(async () => {
      resolveMutation!({ success: true });
      await pending;
    });
    expect(result.current.pending).toBe(false);
  });
});
