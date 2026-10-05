// @vitest-environment node
//
// jsdom always has a `window.location`, so the client's no-page-URL cases need
// their own file with a node environment.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handleOauthCallback,
  readOauthCallback,
  startOauthSignIn,
} from "./client.ts";
import { acmeRefs, oauthContext, readFlow } from "./testFlow.ts";

describe("OAuth client with no page URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("the callback functions do nothing when there is no window", () => {
    const { auth, convex, completeMutation, startMutation } = oauthContext();

    expect(readOauthCallback()).toBeNull();
    expect(handleOauthCallback({ auth, convex })).toBe(false);

    expect(completeMutation).not.toHaveBeenCalled();
    expect(startMutation).not.toHaveBeenCalled();
  });

  test("the callback functions do nothing when the window has no location", () => {
    // The React Native shape. Reading `window.location.href` here would throw.
    vi.stubGlobal("window", {});
    const { auth, convex, completeMutation, startMutation } = oauthContext();

    expect(readOauthCallback()).toBeNull();
    expect(handleOauthCallback({ auth, convex })).toBe(false);

    expect(completeMutation).not.toHaveBeenCalled();
    expect(startMutation).not.toHaveBeenCalled();
  });

  test("startOauthSignIn without redirectTo says redirectTo is required", async () => {
    vi.stubGlobal("window", {});
    const { auth, convex, startMutation } = oauthContext();

    await expect(startOauthSignIn({ auth, convex }, acmeRefs)).rejects.toThrow(
      /`redirectTo` is required/,
    );
    expect(startMutation).not.toHaveBeenCalled();
  });

  test("a start that throws leaves the previous flow error alone", async () => {
    vi.stubGlobal("window", {});
    const { auth, convex, flowError } = oauthContext();
    // A code with no stored flow is the cheapest way to set an error.
    await startOauthSignIn({ auth, convex }, acmeRefs, { code: "code-1" });
    expect(flowError()?.code).toBe("invalid_flow");

    await expect(
      startOauthSignIn({ auth, convex }, acmeRefs),
    ).rejects.toThrow();

    expect(flowError()?.code).toBe("invalid_flow");
  });

  test("startOauthSignIn with redirectTo starts a flow without navigating", async () => {
    // Assigning `window.location.href` would throw here, so a flow that starts
    // must not try. React Native opens the returned url itself.
    vi.stubGlobal("window", {});
    const { auth, convex, startMutation, storage } = oauthContext();
    startMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-1",
    });

    const outcome = await startOauthSignIn({ auth, convex }, acmeRefs, {
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
