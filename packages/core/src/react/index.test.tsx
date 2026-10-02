// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../lib/types.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import { useOauth } from "../oauth/react.ts";
import {
  calledPath,
  invalidCode,
  readFlow,
  seedPendingFlow,
} from "../oauth/testFlow.ts";
import { ConvexAuthProvider, useAuthSignInApi } from "./index.tsx";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
};

/**
 * A real Convex client against a fake deployment URL. Nothing here
 * authenticates or subscribes, so it never opens a connection.
 */
function makeConvexClient() {
  return new ConvexReactClient("https://happy-animal-123.convex.cloud");
}

/**
 * Renders the OAuth flow error. The hook throws without an OAuth client, so
 * rendering this at all is an assertion.
 */
function OauthFlowError() {
  const { flowError } = useOauth();
  return <div>{flowError === null ? "no error" : flowError.code}</div>;
}

describe("ConvexAuthProvider sign-in wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  test("the sign-in api routes through the Convex client", async () => {
    const client = makeConvexClient();
    const mutationSpy = vi
      .spyOn(client, "mutation")
      .mockResolvedValue("result" as never);
    const signIn = makeFunctionReference<"mutation">("auth:signInProbe");
    const captured: AuthSignInApi[] = [];
    function Capture() {
      captured.push(useAuthSignInApi());
      return null;
    }
    render(
      <ConvexAuthProvider client={client} api={API}>
        <Capture />
      </ConvexAuthProvider>,
    );
    await expect(captured[0].mutation(signIn, {})).resolves.toBe("result");
    expect(mutationSpy).toHaveBeenCalledWith(signIn, {});
  });

  test("OAuth is set up", () => {
    const client = makeConvexClient();
    render(
      <ConvexAuthProvider client={client} api={API}>
        <OauthFlowError />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("no error")).toBeDefined();
  });

  test("a callback code is redeemed once under StrictMode", async () => {
    // The redemption fails, so the client never authenticates and the Convex
    // client never connects. Reaching the failure is what proves the wiring:
    // the callback was handled, through the Convex client, with the saved
    // flow from the storage the provider was given.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const client = makeConvexClient();
    const mutationSpy = vi
      .spyOn(client, "mutation")
      .mockResolvedValue(invalidCode as never);
    render(
      <StrictMode>
        <ConvexAuthProvider client={client} api={API} storage={storage}>
          <OauthFlowError />
        </ConvexAuthProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText("expired")).toBeDefined());
    expect(mutationSpy).toHaveBeenCalledOnce();
    expect(calledPath(mutationSpy)).toBe("auth:completeSignInAcme");
    expect(readFlow(storage)).toBeNull();
    expect(window.location.search).toBe("");
  });
});
