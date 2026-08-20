// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { StrictMode } from "react";
import { describe, expect, test, vi } from "vitest";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../browser/ambientSignInClient";
import { ConvexAuthProvider, useAuthSignInApi } from "./index";
import { useAmbientSignInValue } from "./providers";

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

/** Renders the value a probe setup publishes under its scoped `status` key. */
function ProbeStatus() {
  const status = useAmbientSignInValue<string>("probe", "status");
  return <div>{status ?? "missing"}</div>;
}

describe("ConvexAuthProvider ambient sign-ins", () => {
  test("published setup values are readable on the first render", () => {
    const client = makeConvexClient();
    const probe: AmbientSignInClient = {
      id: "probe",
      setup: (ctx) => {
        ctx.values.set("status", "registered");
      },
    };
    render(
      <ConvexAuthProvider client={client} api={API} ambientSignIns={[probe]}>
        <ProbeStatus />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("registered")).toBeDefined();
  });

  test("onInit runs once per client under StrictMode", () => {
    const client = makeConvexClient();
    const onInit = vi.fn();
    render(
      <StrictMode>
        <ConvexAuthProvider
          client={client}
          api={API}
          ambientSignIns={[{ id: "probe", setup: () => ({ onInit }) }]}
        >
          <div />
        </ConvexAuthProvider>
      </StrictMode>,
    );
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  test("setups and hooks receive the same sign-in api", () => {
    const client = makeConvexClient();
    const fromSetup: AuthSignInApi[] = [];
    const fromHook: AuthSignInApi[] = [];
    function Capture() {
      fromHook.push(useAuthSignInApi());
      return null;
    }
    render(
      <ConvexAuthProvider
        client={client}
        api={API}
        ambientSignIns={[
          {
            id: "probe",
            setup: (ctx) => {
              fromSetup.push(ctx.signInApi);
            },
          },
        ]}
      >
        <Capture />
      </ConvexAuthProvider>,
    );
    expect(fromHook[0]).toBe(fromSetup[0]);
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
});
