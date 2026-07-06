import { createOAuthRefreshDomain } from "@robelest/convex-auth/server/oauth/refresh";
import { expect, test } from "vite-plus/test";

const refs = {
  exchange: { fn: "oauth.refresh.exchange" },
  revoke: { fn: "oauth.refresh.revoke" },
  create: { fn: "oauth.refresh.create" },
  append: { fn: "event.append" },
};

const component = {
  oauth: { refresh: { exchange: refs.exchange, revoke: refs.revoke, create: refs.create } },
  event: { append: refs.append, get: {}, list: {} },
};

type Appended = {
  kind: string;
  actor: unknown;
  subject: unknown;
  outcome: string;
  data: unknown;
  targets: unknown;
};

function makeCtx(handlers: Map<unknown, (args: unknown) => unknown>) {
  const appended: Appended[] = [];
  const ctx = {
    runMutation: async (ref: unknown, args: { event?: Appended }) => {
      if (ref === refs.append) {
        appended.push(args.event!);
        return { created: true, eventId: "evt", createdTargets: [], projections: [] };
      }
      const handler = handlers.get(ref);
      if (!handler) throw new Error("unexpected runMutation ref");
      return handler(args);
    },
  };
  return { ctx, appended };
}

const domain = createOAuthRefreshDomain({ component: component as never });

test("server exchange emits oauth.refresh.reuse_detected on theft and still returns null", async () => {
  const { ctx, appended } = makeCtx(
    new Map([
      [refs.exchange, () => ({ status: "reuse_detected", userId: "user1", clientId: "oc_x" })],
    ]),
  );
  const result = await domain.exchange(ctx as never, {
    refreshToken: "rt_stolen",
    clientId: "oc_x",
  });

  expect(result).toBeNull();
  expect(appended).toHaveLength(1);
  const ev = appended[0]!;
  expect(ev.kind).toBe("oauth.refresh.reuse_detected");
  expect(ev.actor).toEqual({ type: "oauth_client", id: "oc_x" });
  expect(ev.subject).toEqual({ type: "user", id: "user1" });
  expect(ev.outcome).toBe("failure");
  expect(ev.data).toEqual({ clientId: "oc_x", userId: "user1" });
  expect(ev.targets).toEqual([
    { kind: "oauth_client", id: "oc_x" },
    { kind: "user", id: "user1" },
  ]);
});

test("server exchange returns the grant and emits nothing on a successful rotation", async () => {
  const { ctx, appended } = makeCtx(
    new Map([
      [refs.exchange, () => ({ status: "rotated", userId: "user1", scopes: ["workspace:read"] })],
    ]),
  );
  const result = await domain.exchange(ctx as never, { refreshToken: "rt_ok", clientId: "oc_x" });

  expect(result).toMatchObject({ userId: "user1", scopes: ["workspace:read"] });
  if (!result || "scopeExceeded" in result) throw new Error("expected a rotated result");
  expect(result.refreshToken).toMatch(/^rt_/);
  expect(appended).toHaveLength(0);
});

test("server exchange returns null without emitting on an invalid token", async () => {
  const { ctx, appended } = makeCtx(new Map([[refs.exchange, () => ({ status: "invalid" })]]));
  const result = await domain.exchange(ctx as never, { refreshToken: "rt_bad", clientId: "oc_x" });

  expect(result).toBeNull();
  expect(appended).toHaveLength(0);
});

test("server revoke emits oauth.refresh.revoked when a token matched", async () => {
  const { ctx, appended } = makeCtx(
    new Map([[refs.revoke, () => ({ userId: "user1", clientId: "oc_x" })]]),
  );
  await domain.revoke(ctx as never, { refreshToken: "rt_z" });

  expect(appended).toHaveLength(1);
  const ev = appended[0]!;
  expect(ev.kind).toBe("oauth.refresh.revoked");
  expect(ev.actor).toEqual({ type: "system" });
  expect(ev.subject).toEqual({ type: "user", id: "user1" });
  expect(ev.outcome).toBe("success");
  expect(ev.data).toEqual({ clientId: "oc_x", userId: "user1" });
});

test("server revoke emits nothing when no token matched", async () => {
  const { ctx, appended } = makeCtx(new Map([[refs.revoke, () => null]]));
  await domain.revoke(ctx as never, { refreshToken: "rt_none" });

  expect(appended).toHaveLength(0);
});
