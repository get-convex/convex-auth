// @vitest-environment node
//
// jsdom always has a `window.location`, so the client's no-page-URL cases need
// their own file with a node environment.
import { afterEach, describe, expect, test, vi } from "vitest";
import { ACME_REFS, readFlow, setupOAuth } from "./testFlow.js";

describe("OAuth client with no page URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("init does nothing when there is no window", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, mutation } = setupOAuth();

    await client.init();

    expect(logged).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  test("init does nothing when the window has no location", async () => {
    // The React Native shape. Reading `window.location.href` here would throw,
    // and the thrown error would be logged as a failed init callback.
    vi.stubGlobal("window", {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, mutation } = setupOAuth();

    await client.init();

    expect(logged).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  test("signIn without redirectTo says redirectTo is required", async () => {
    vi.stubGlobal("window", {});
    const { actions, mutation } = setupOAuth();

    await expect(actions.signIn(ACME_REFS)).rejects.toThrow(
      /`redirectTo` is required/,
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  test("a signIn that throws leaves the previous flow error alone", async () => {
    vi.stubGlobal("window", {});
    const { actions, flowError } = setupOAuth();
    // A code with no stored flow is the cheapest way to put an error in place.
    await actions.signIn(ACME_REFS, { code: "code-1" });
    expect(flowError()?.code).toBe("invalid_flow");

    await expect(actions.signIn(ACME_REFS)).rejects.toThrow();

    expect(flowError()?.code).toBe("invalid_flow");
  });

  test("signIn with redirectTo starts a flow without navigating", async () => {
    // Assigning `window.location.href` would throw here, so a flow that starts
    // must not try. React Native opens the returned url itself.
    vi.stubGlobal("window", {});
    const { actions, mutation, storage } = setupOAuth();
    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-1",
    });

    const outcome = await actions.signIn(ACME_REFS, {
      redirectTo: "https://app.example/done",
    });

    expect(outcome).toEqual({
      redirect: new URL("https://provider.example/auth"),
    });
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-1",
      completeSignIn: "auth:completeSignInAcme",
    });
  });
});
