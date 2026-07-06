import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { expect, test } from "vite-plus/test";

import type { OAuthTokenEndpointAuthMethod } from "../packages/auth/src/server/oauth/client";
import { createRegisterHandler } from "../packages/auth/src/server/oauth/register";

const ALLOWED = ["workspace:read", "workspace:write"];
const ctx = {} as GenericActionCtx<GenericDataModel>;

type CreateOpts = {
  name: string;
  redirectUris: string[];
  scopes: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
};

function registrationClientUri(clientId: string): string {
  return `https://app.convex.site/auth/oauth2/register/${clientId}`;
}

function request(body: unknown): Request {
  return new Request("https://app.convex.site/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("DCR registers a confidential client and clamps scopes to the allowed set", async () => {
  let captured: CreateOpts | null = null;
  const handler = createRegisterHandler({
    allowedScopes: ALLOWED,
    registrationClientUri,
    createClient: async (_c, opts) => {
      captured = opts;
      return {
        clientId: "oc_test",
        clientSecret: "cs_test",
        registrationAccessToken: "reg_test",
        tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod,
      };
    },
  });

  const res = await handler(
    ctx,
    request({
      client_name: "agent",
      redirect_uris: ["http://localhost:8787/callback"],
      scope: "workspace:read workspace:write offline_access",
    }),
  );

  expect(res.status).toBe(201);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.client_id).toBe("oc_test");
  expect(json.client_secret).toBe("cs_test");
  expect(json.client_secret_expires_at).toBe(0);
  expect(json.token_endpoint_auth_method).toBe("client_secret_post");
  expect(json.scope).toBe("workspace:read workspace:write");
  expect(json.registration_access_token).toBe("reg_test");
  expect(json.registration_client_uri).toBe("https://app.convex.site/auth/oauth2/register/oc_test");
  expect(captured!.scopes).toEqual(["workspace:read", "workspace:write"]);
  expect(captured!.grantTypes).toEqual(["authorization_code", "refresh_token"]);
  expect(captured!.tokenEndpointAuthMethod).toBe("client_secret_post");
});

test("DCR registers a public client (none): no secret, PKCE-only, still gets a reg token", async () => {
  let captured: CreateOpts | null = null;
  const handler = createRegisterHandler({
    allowedScopes: ALLOWED,
    registrationClientUri,
    createClient: async (_c, opts) => {
      captured = opts;
      return {
        clientId: "oc_pub",
        registrationAccessToken: "reg_pub",
        tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod,
      };
    },
  });

  const res = await handler(
    ctx,
    request({
      redirect_uris: ["https://app.example.com/cb"],
      token_endpoint_auth_method: "none",
    }),
  );

  expect(res.status).toBe(201);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.client_id).toBe("oc_pub");
  expect(json.client_secret).toBeUndefined();
  expect(json.client_secret_expires_at).toBeUndefined();
  expect(json.token_endpoint_auth_method).toBe("none");
  expect(json.registration_access_token).toBe("reg_pub");
  expect(captured!.tokenEndpointAuthMethod).toBe("none");
});

test("DCR defaults to all allowed scopes when none are requested", async () => {
  let captured: CreateOpts | null = null;
  const handler = createRegisterHandler({
    allowedScopes: ALLOWED,
    registrationClientUri,
    createClient: async (_c, opts) => {
      captured = opts;
      return {
        clientId: "oc_x",
        clientSecret: "cs_x",
        registrationAccessToken: "reg_x",
        tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod,
      };
    },
  });

  const res = await handler(ctx, request({ redirect_uris: ["https://app.example.com/cb"] }));
  expect(res.status).toBe(201);
  expect(captured!.scopes).toEqual(ALLOWED);
});

test("DCR rejects missing or non-https/localhost redirect_uris", async () => {
  const handler = createRegisterHandler({
    allowedScopes: ALLOWED,
    registrationClientUri,
    createClient: async (_c, opts) => ({
      clientId: "x",
      clientSecret: "y",
      registrationAccessToken: "reg_y",
      tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod,
    }),
  });

  const missing = await handler(ctx, request({ redirect_uris: [] }));
  expect(missing.status).toBe(400);

  const insecure = await handler(ctx, request({ redirect_uris: ["http://evil.example.com/cb"] }));
  expect(insecure.status).toBe(400);
});

test("DCR rejects an unsupported token_endpoint_auth_method", async () => {
  const handler = createRegisterHandler({
    allowedScopes: ALLOWED,
    registrationClientUri,
    createClient: async (_c, opts) => ({
      clientId: "x",
      clientSecret: "y",
      registrationAccessToken: "reg_y",
      tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod,
    }),
  });

  const res = await handler(
    ctx,
    request({
      redirect_uris: ["https://app.example.com/cb"],
      token_endpoint_auth_method: "private_key_jwt",
    }),
  );
  expect(res.status).toBe(400);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.error).toBe("invalid_client_metadata");
});
