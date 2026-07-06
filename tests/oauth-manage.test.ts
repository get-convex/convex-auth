import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { expect, test } from "vite-plus/test";

import type { OAuthClientDoc, OAuthClientUpdate } from "../packages/auth/src/server/oauth/client";
import { createClientManagementHandler } from "../packages/auth/src/server/oauth/manage";

const ALLOWED = ["workspace:read", "workspace:write"];
const ctx = {} as GenericActionCtx<GenericDataModel>;

function clientDoc(overrides: Partial<OAuthClientDoc> = {}): OAuthClientDoc {
  return {
    _id: "doc_1" as OAuthClientDoc["_id"],
    _creationTime: 0,
    clientId: "oc_1",
    clientSecretHash: "hash",
    name: "agent",
    redirectUris: ["https://app.example.com/cb"],
    scopes: ["workspace:read"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: "client_secret_post",
    revoked: false,
    ...overrides,
  };
}

/**
 * Build a handler whose registration-token check only passes for `oc_1` with
 * the token `reg_good` — modeling the per-client binding so a token for one
 * client never authenticates against another.
 */
function makeHandler(opts?: {
  doc?: OAuthClientDoc;
  onUpdate?: (args: { clientId: string; patch: OAuthClientUpdate }) => void;
  onRevoke?: (args: { clientId: string }) => void;
}) {
  return createClientManagementHandler({
    allowedScopes: ALLOWED,
    registrationClientUri: (clientId) => `https://app.convex.site/auth/oauth2/register/${clientId}`,
    verifyRegistrationToken: async (_c, { clientId, token }) =>
      clientId === "oc_1" && token === "reg_good" ? (opts?.doc ?? clientDoc()) : null,
    update: async (_c, args) => {
      opts?.onUpdate?.(args);
    },
    revoke: async (_c, args) => {
      opts?.onRevoke?.(args);
      return { clientId: args.clientId };
    },
  });
}

function req(clientId: string, method: string, opts?: { token?: string; body?: unknown }): Request {
  const headers: Record<string, string> = {};
  if (opts?.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts?.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://app.convex.site/auth/oauth2/register/${clientId}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

test("GET returns the client metadata without re-disclosing secrets", async () => {
  const res = await makeHandler()(ctx, req("oc_1", "GET", { token: "reg_good" }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.client_id).toBe("oc_1");
  expect(json.token_endpoint_auth_method).toBe("client_secret_post");
  expect(json.scope).toBe("workspace:read");
  expect(json.registration_client_uri).toBe("https://app.convex.site/auth/oauth2/register/oc_1");
  expect(json.client_secret).toBeUndefined();
  expect(json.registration_access_token).toBeUndefined();
});

test("a missing or wrong registration access token is rejected with 401", async () => {
  const handler = makeHandler();
  expect((await handler(ctx, req("oc_1", "GET"))).status).toBe(401);
  expect((await handler(ctx, req("oc_1", "GET", { token: "reg_wrong" }))).status).toBe(401);
});

test("a token bound to one client cannot manage another", async () => {
  const res = await makeHandler()(ctx, req("oc_2", "GET", { token: "reg_good" }));
  expect(res.status).toBe(401);
});

test("a deeper path than /register/<id> is not a management endpoint", async () => {
  const res = await makeHandler()(ctx, req("oc_1/extra", "GET", { token: "reg_good" }));
  expect(res.status).toBe(404);
});

test("PUT replaces metadata and clamps scopes to the allowed set", async () => {
  let captured: { clientId: string; patch: OAuthClientUpdate } | null = null;
  const res = await makeHandler({ onUpdate: (a) => (captured = a) })(
    ctx,
    req("oc_1", "PUT", {
      token: "reg_good",
      body: {
        client_name: "renamed",
        redirect_uris: ["https://app.example.com/next"],
        scope: "workspace:read workspace:write offline_access",
      },
    }),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.client_name).toBe("renamed");
  expect(json.redirect_uris).toEqual(["https://app.example.com/next"]);
  expect(json.scope).toBe("workspace:read workspace:write");
  expect(captured!.clientId).toBe("oc_1");
  expect(captured!.patch.scopes).toEqual(["workspace:read", "workspace:write"]);
});

test("PUT rejects an invalid redirect_uri without updating", async () => {
  let updated = false;
  const res = await makeHandler({ onUpdate: () => (updated = true) })(
    ctx,
    req("oc_1", "PUT", {
      token: "reg_good",
      body: { redirect_uris: ["http://evil.example.com/cb"] },
    }),
  );
  expect(res.status).toBe(400);
  expect(updated).toBe(false);
});

test("PUT can downgrade a confidential client to public", async () => {
  let captured: { clientId: string; patch: OAuthClientUpdate } | null = null;
  const res = await makeHandler({ onUpdate: (a) => (captured = a) })(
    ctx,
    req("oc_1", "PUT", {
      token: "reg_good",
      body: {
        redirect_uris: ["https://app.example.com/cb"],
        token_endpoint_auth_method: "none",
      },
    }),
  );
  expect(res.status).toBe(200);
  expect(captured!.patch.tokenEndpointAuthMethod).toBe("none");
});

test("PUT cannot upgrade a public client to confidential", async () => {
  let updated = false;
  const res = await makeHandler({
    doc: clientDoc({ tokenEndpointAuthMethod: "none", clientSecretHash: undefined }),
    onUpdate: () => (updated = true),
  })(
    ctx,
    req("oc_1", "PUT", {
      token: "reg_good",
      body: {
        redirect_uris: ["https://app.example.com/cb"],
        token_endpoint_auth_method: "client_secret_post",
      },
    }),
  );
  expect(res.status).toBe(400);
  expect(updated).toBe(false);
});

test("DELETE deregisters the client and returns 204", async () => {
  let revoked: { clientId: string } | null = null;
  const res = await makeHandler({ onRevoke: (a) => (revoked = a) })(
    ctx,
    req("oc_1", "DELETE", { token: "reg_good" }),
  );
  expect(res.status).toBe(204);
  expect(revoked!.clientId).toBe("oc_1");
});
