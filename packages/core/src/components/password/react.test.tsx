// @vitest-environment jsdom
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { useAuthToken } from "../../react/index.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import type { FunctionReference } from "convex/server";
import type {
  ClientView,
  SignInIncomplete,
  SignInSuccess,
} from "../../lib/types.ts";
import type { SignInResult, SignUpResult } from "./setup.ts";
import {
  Credentials,
  renderRequirements,
  SignInWithPasswordResult,
  SignUpWithPasswordResult,
  useRequirementsFlow,
  useSignInWithPassword,
  useSignUpWithPassword,
  type RequirementFlowContext,
} from "./react.tsx";

type Result = SignInWithPasswordResult | SignUpWithPasswordResult;

// The hooks run their action through the injected `AuthSignInApi`, so the test
// substitutes a signInApi rather than mocking `convex/react`.
const { signInApi, run: runMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

const credentials = { username: "alice", password: "hunter2" };

// The stub signInApi ignores the reference values; only their declared types
// matter, driving the hooks' inference the way an app without sign-in
// requirements would (the plain two-arm result unions).
const signInMutation = {} as FunctionReference<
  "mutation",
  "public",
  Credentials,
  ClientView<SignInResult>
>;
const signUpMutation = {} as FunctionReference<
  "mutation",
  "public",
  Credentials,
  ClientView<SignUpResult>
>;

const flows = [
  {
    name: "useSignInWithPassword",
    useFlow: () => {
      const { signIn, pending } = useSignInWithPassword(signInMutation);
      return { run: signIn as (c: Credentials) => Promise<Result>, pending };
    },
  },
  {
    name: "useSignUpWithPassword",
    useFlow: () => {
      const { signUp, pending } = useSignUpWithPassword(signUpMutation);
      return { run: signUp as (c: Credentials) => Promise<Result>, pending };
    },
  },
];

function renderFlow<
  F extends {
    run: (c: typeof credentials) => Promise<unknown>;
    pending: boolean;
  },
>(useFlow: () => F) {
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
    () => ({ auth: useAuth(), token: useAuthToken(), flow: useFlow() }),
    { wrapper },
  );
}

describe.each(flows)("$name", ({ useFlow }) => {
  afterEach(() => {
    vi.restoreAllMocks();
    runMutation.mockReset();
  });

  test("success adopts the session and returns the result", async () => {
    runMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(runMutation).toHaveBeenCalledWith(credentials);
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("user error is returned without adopting a session", async () => {
    const failure = {
      status: "error",
      userError: { error: "USER_NOT_FOUND" },
    };
    runMutation.mockResolvedValue(failure);
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(returned).toEqual(failure);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runMutation.mockRejectedValue(cause);
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("pending is true while in flight and false after", async () => {
    let resolveMutation: (value: unknown) => void;
    runMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.flow.pending).toBe(false);

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.flow.run(credentials);
    });
    await waitFor(() => expect(result.current.flow.pending).toBe(true));

    await act(async () => {
      resolveMutation!({ status: "complete", tokens: bundle });
      await pending;
    });
    expect(result.current.flow.pending).toBe(false);
  });

  test("pending resets to false when the mutation throws", async () => {
    runMutation.mockRejectedValue(new Error("boom"));
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    await act(async () => {
      await result.current.flow.run(credentials);
    });
    expect(result.current.flow.pending).toBe(false);
  });
});

// --- Incomplete sign-ins (requirements) --------------------------------------

/** The closed requirement union an app with requirements would see through
 * its generated api types. */
type TestRequirement = { kind: "test:verify"; data: { hint: string } };

const reqSignInMutation = {} as FunctionReference<
  "mutation",
  "public",
  Credentials,
  ClientView<
    | SignInSuccess
    | SignInIncomplete<TestRequirement>
    | { status: "error"; userError: { error: "USER_NOT_FOUND" } }
  >
>;

const reqContinueMutation = {} as FunctionReference<
  "mutation",
  "public",
  { attemptToken: string },
  ClientView<
    | SignInSuccess
    | SignInIncomplete<TestRequirement>
    | { status: "error"; userError: { error: "ATTEMPT_EXPIRED" } }
  >
>;

const incompleteResult = {
  status: "incomplete",
  requirements: [{ kind: "test:verify", data: { hint: "prove it" } }],
  attemptToken: "attempt-1",
  expiresAt: 4102444800000,
};

describe("incomplete sign-ins", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runMutation.mockReset();
  });

  function renderRequirementsFlow(withContinue = true) {
    return renderFlow(() => {
      const { signIn, pending } = useSignInWithPassword(
        reqSignInMutation,
        withContinue ? reqContinueMutation : undefined,
      );
      return { run: signIn, pending };
    });
  }

  test("an incomplete result withholds the session and continueWith resumes it", async () => {
    runMutation
      .mockResolvedValueOnce(incompleteResult)
      .mockResolvedValueOnce({ status: "complete", tokens: bundle });
    const { result } = renderRequirementsFlow();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.flow.run>>;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(returned.status).toBe("incomplete");
    if (returned.status !== "incomplete") {
      throw new Error("expected an incomplete result");
    }
    expect(returned.requirements).toEqual(incompleteResult.requirements);
    // No session was adopted for the incomplete round.
    expect(result.current.auth.isAuthenticated).toBe(false);
    const { continueWith } = returned;

    let next!: Awaited<ReturnType<typeof continueWith>>;
    await act(async () => {
      next = await continueWith();
    });
    expect(runMutation).toHaveBeenLastCalledWith({
      attemptToken: "attempt-1",
    });
    expect(next).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
  });

  test("a still-incomplete continuation is augmented again (multi-round)", async () => {
    runMutation
      .mockResolvedValueOnce(incompleteResult)
      .mockResolvedValueOnce(incompleteResult)
      .mockResolvedValueOnce({ status: "complete", tokens: bundle });
    const { result } = renderRequirementsFlow();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let first!: Awaited<ReturnType<typeof result.current.flow.run>>;
    await act(async () => {
      first = await result.current.flow.run(credentials);
    });
    if (first.status !== "incomplete") {
      throw new Error("expected an incomplete result");
    }
    const firstIncomplete = first;

    let second!: Awaited<ReturnType<typeof firstIncomplete.continueWith>>;
    await act(async () => {
      second = await firstIncomplete.continueWith();
    });
    if (second.status !== "incomplete") {
      throw new Error("expected a second incomplete result");
    }
    const secondIncomplete = second;

    let third!: Awaited<ReturnType<typeof secondIncomplete.continueWith>>;
    await act(async () => {
      third = await secondIncomplete.continueWith();
    });
    expect(third).toEqual({ status: "complete", tokens: bundle });
  });

  test("ATTEMPT_EXPIRED from the continue mutation passes through", async () => {
    const expired = {
      status: "error",
      userError: { error: "ATTEMPT_EXPIRED" },
    };
    runMutation
      .mockResolvedValueOnce(incompleteResult)
      .mockResolvedValueOnce(expired);
    const { result } = renderRequirementsFlow();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.flow.run>>;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });
    if (returned.status !== "incomplete") {
      throw new Error("expected an incomplete result");
    }
    const { continueWith } = returned;

    let next!: Awaited<ReturnType<typeof continueWith>>;
    await act(async () => {
      next = await continueWith();
    });
    expect(next).toEqual(expired);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown continue mutation folds into OTHER_ERROR", async () => {
    const cause = new Error("network blip");
    runMutation
      .mockResolvedValueOnce(incompleteResult)
      .mockRejectedValueOnce(cause);
    const { result } = renderRequirementsFlow();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.flow.run>>;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });
    if (returned.status !== "incomplete") {
      throw new Error("expected an incomplete result");
    }
    const { continueWith } = returned;

    let next!: Awaited<ReturnType<typeof continueWith>>;
    await act(async () => {
      next = await continueWith();
    });
    expect(next).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("continueWith without a configured continue mutation throws a setup error", async () => {
    runMutation.mockResolvedValueOnce(incompleteResult);
    const { result } = renderRequirementsFlow(false);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.flow.run>>;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });
    if (returned.status !== "incomplete") {
      throw new Error("expected an incomplete result");
    }
    await expect(returned.continueWith()).rejects.toThrow(/continue mutation/);
  });
});

// --- Requirements-flow helpers ------------------------------------------------

describe("useRequirementsFlow", () => {
  const requirement = { kind: "test:verify" as const, data: { hint: "2+2" } };

  function incompleteWith(continueWith: () => Promise<unknown>) {
    return {
      status: "incomplete" as const,
      requirements: [requirement],
      attemptToken: "attempt-1",
      expiresAt: 4102444800000,
      continueWith,
    };
  }

  test("adopts a still-incomplete round, then reports completion", async () => {
    const nextRequirement = { kind: "test:other" as const, data: {} };
    const secondRound = {
      status: "incomplete" as const,
      requirements: [nextRequirement],
      attemptToken: "attempt-1",
      expiresAt: 4102444800000,
      continueWith: vi
        .fn()
        .mockResolvedValue({ status: "complete", tokens: {} }),
    };
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useRequirementsFlow(
        incompleteWith(vi.fn().mockResolvedValue(secondRound)),
        { onExpired },
      ),
    );
    expect(result.current.requirements).toEqual([requirement]);
    expect(result.current.attemptToken).toBe("attempt-1");

    let status!: Awaited<ReturnType<typeof result.current.continueSignIn>>;
    await act(async () => {
      status = await result.current.continueSignIn();
    });
    expect(status).toBe("incomplete");
    // The fresh round was adopted: requirements and continueWith swap over.
    expect(result.current.requirements).toEqual([nextRequirement]);

    await act(async () => {
      status = await result.current.continueSignIn();
    });
    expect(status).toBe("complete");
    expect(secondRound.continueWith).toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  test("an expired attempt reports expired and calls onExpired", async () => {
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useRequirementsFlow(
        incompleteWith(
          vi.fn().mockResolvedValue({
            status: "error",
            userError: { error: "ATTEMPT_EXPIRED" },
          }),
        ),
        { onExpired },
      ),
    );

    let status!: Awaited<ReturnType<typeof result.current.continueSignIn>>;
    await act(async () => {
      status = await result.current.continueSignIn();
    });
    expect(status).toBe("expired");
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  test("an unexpected failure lands in the error state and clears on retry", async () => {
    const cause = new Error("network blip");
    const failure = {
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    };
    const continueWith = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ status: "complete", tokens: {} });
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useRequirementsFlow(incompleteWith(continueWith), { onExpired }),
    );

    let status!: Awaited<ReturnType<typeof result.current.continueSignIn>>;
    await act(async () => {
      status = await result.current.continueSignIn();
    });
    expect(status).toBe("error");
    expect(result.current.error).toEqual({ error: "OTHER_ERROR", cause });
    expect(onExpired).not.toHaveBeenCalled();

    await act(async () => {
      status = await result.current.continueSignIn();
    });
    expect(status).toBe("complete");
    expect(result.current.error).toBeNull();
  });
});

describe("renderRequirements", () => {
  const context: RequirementFlowContext = {
    attemptToken: "attempt-1",
    expiresAt: 0,
    continueSignIn: async () => "complete" as const,
    expire: () => {},
  };
  type Req =
    | { kind: "test:verify"; data: { hint: string } }
    | { kind: "test:other"; data: Record<string, never> };

  test("dispatches each requirement to its kind's handler with the context", () => {
    const requirements: Req[] = [
      { kind: "test:verify", data: { hint: "2+2" } },
      { kind: "test:other", data: {} },
    ];
    render(
      <>
        {renderRequirements(requirements, context, {
          "test:verify": (req, ctx) => (
            <p>
              challenge {req.data.hint} for {ctx.attemptToken}
            </p>
          ),
          "test:other": () => <p>other step</p>,
        })}
      </>,
    );
    screen.getByText("challenge 2+2 for attempt-1");
    screen.getByText("other step");
  });

  test("an unknown kind (version skew) falls back", () => {
    // A backend that registered a kind this build predates: the closed
    // union is a compile-time promise, so simulate the skew with a cast.
    const requirements = [
      { kind: "future:kind", data: {} },
    ] as unknown as Req[];
    render(
      <>
        {renderRequirements(requirements, context, {
          "test:verify": () => <p>never rendered</p>,
          "test:other": () => <p>never rendered</p>,
          fallback: (req) => <p>unsupported: {req.kind}</p>,
        })}
      </>,
    );
    screen.getByText("unsupported: future:kind");
  });

  test("an unknown kind without a fallback renders nothing", () => {
    const requirements = [
      { kind: "future:kind", data: {} },
    ] as unknown as Req[];
    const { container } = render(
      <>
        {renderRequirements(requirements, context, {
          "test:verify": () => <p>never rendered</p>,
          "test:other": () => <p>never rendered</p>,
        })}
      </>,
    );
    expect(container.textContent).toBe("");
  });
});
