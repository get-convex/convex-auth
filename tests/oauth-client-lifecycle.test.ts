import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

/**
 * Regression tests for OAuth client lifecycle hardening (perf/growth cluster,
 * item 4): component-level scope clamping on `create`, a hard-delete `remove`
 * path, and the `prune` retention GC for revoked clients.
 *
 * The new component functions/args may not be reflected in the app's generated
 * types until codegen runs, so the refs are accessed with `as any`; convex-test
 * resolves them by name at runtime.
 */

const clientApi = () => components.auth.oauth.client as any;

async function createClient(t: any, args: Record<string, unknown>) {
  return await t.run(async (ctx: any) => {
    return await ctx.runMutation(clientApi().create, {
      redirectUris: ["https://app.example.com/cb"],
      grantTypes: ["authorization_code"],
      ...args,
    });
  });
}

async function getClient(t: any, clientId: string) {
  return await t.run(async (ctx: any) =>
    ctx.runQuery(components.auth.oauth.client.get, { clientId }),
  );
}

test("client.create clamps requested scopes to allowedScopes", async () => {
  const t = convexTest(schema);
  await createClient(t, {
    clientId: "oc_clamp",
    name: "Clamp",
    scopes: ["workspace:read", "workspace:write", "workspace:admin"],
    allowedScopes: ["workspace:read", "workspace:write"],
  });
  const doc: any = await getClient(t, "oc_clamp");
  expect(doc).not.toBeNull();
  expect(doc.scopes).toEqual(["workspace:read", "workspace:write"]);
});

test("client.create without allowedScopes stores scopes as-is (trusted admin path)", async () => {
  const t = convexTest(schema);
  await createClient(t, {
    clientId: "oc_trusted",
    name: "Trusted",
    scopes: ["workspace:read", "workspace:admin"],
  });
  const doc: any = await getClient(t, "oc_trusted");
  expect(doc.scopes).toEqual(["workspace:read", "workspace:admin"]);
});

test("client.remove hard-deletes the registration row", async () => {
  const t = convexTest(schema);
  await createClient(t, { clientId: "oc_del", name: "Deletable", scopes: [] });
  expect(await getClient(t, "oc_del")).not.toBeNull();

  await t.run(async (ctx: any) => ctx.runMutation(clientApi().remove, { clientId: "oc_del" }));
  expect(await getClient(t, "oc_del")).toBeNull();
});

test("client.prune hard-deletes only revoked clients older than `before`", async () => {
  const t = convexTest(schema);
  await createClient(t, { clientId: "oc_revoked", name: "Revoked", scopes: [] });
  await createClient(t, { clientId: "oc_live", name: "Live", scopes: [] });
  await t.run(async (ctx: any) =>
    ctx.runMutation(components.auth.oauth.client.revoke, { clientId: "oc_revoked" }),
  );

  // `before` in the future: the revoked client is eligible; the live one is not.
  const result: any = await t.run(async (ctx: any) =>
    ctx.runMutation(clientApi().prune, { before: Date.now() + 60_000 }),
  );
  expect(result.deleted).toBe(1);
  expect(await getClient(t, "oc_revoked")).toBeNull();
  expect(await getClient(t, "oc_live")).not.toBeNull();
});

test("client.prune respects `before`: too-recent revoked clients are kept", async () => {
  const t = convexTest(schema);
  await createClient(t, { clientId: "oc_recent", name: "Recent", scopes: [] });
  await t.run(async (ctx: any) =>
    ctx.runMutation(components.auth.oauth.client.revoke, { clientId: "oc_recent" }),
  );

  // `before` in the distant past: nothing is old enough to prune.
  const result: any = await t.run(async (ctx: any) =>
    ctx.runMutation(clientApi().prune, { before: 1 }),
  );
  expect(result.deleted).toBe(0);
  expect(await getClient(t, "oc_recent")).not.toBeNull();
});

test("client.prune default preserves newly revoked clients for audit retention", async () => {
  const t = convexTest(schema);
  await createClient(t, { clientId: "oc_audit", name: "Audit", scopes: [] });
  await t.run(async (ctx: any) =>
    ctx.runMutation(components.auth.oauth.client.revoke, { clientId: "oc_audit" }),
  );

  const result: any = await t.run(async (ctx: any) => ctx.runMutation(clientApi().prune, {}));
  expect(result.deleted).toBe(0);
  const retained: any = await getClient(t, "oc_audit");
  expect(retained).not.toBeNull();
  expect(retained.revokedAt).toEqual(expect.any(Number));
});
