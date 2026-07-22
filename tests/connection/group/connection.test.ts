import { api, components } from "@convex/_generated/api";
import { auth } from "@convex/auth";
import schema from "@convex/schema";
import { sha256 } from "@robelest/convex-auth/server/random";
import { encryptSecret } from "@robelest/convex-auth/server/secret";
import {
  getPublicConnectionConfig,
  getPublicOidcConfig,
  getPublicSamlConfig,
  upsertProtocolConfig,
} from "@robelest/convex-auth/server/connection/config";
import { createGroupConnectionOidcProvider } from "@robelest/convex-auth/server/connection/oidc";
import { resolveProvisionedRoleIds } from "@robelest/convex-auth/server/connection/policy";
import {
  createServiceProviderMetadata,
  enforceSamlAlgorithmPolicy,
  enforceSamlMetadataSize,
  enforceSamlResponseSize,
  enforceGroupConnectionSamlSecurity,
  parseSamlIdpMetadata,
} from "@robelest/convex-auth/server/connection/saml";
import { parseScimListRequest } from "@robelest/convex-auth/server/connection/scim";
import {
  decodeGroupOidcState,
  encodeGroupOidcState,
  getGroupOidcUrls,
  getGroupSamlUrls,
  isGroupSamlSourceActive,
  groupOidcProviderId,
  groupSamlProviderId,
} from "@robelest/convex-auth/server/connection/shared";
import idpMetadataXml from "./idpmeta.xml?raw";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { convexTest } from "../../convex/setup";

const GROUP_CONNECTION_SITE_URL = "https://convex-auth.example.com";
const GROUP_CONNECTION_AUTH_SITE_URL = `${GROUP_CONNECTION_SITE_URL}/auth`;

const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
});

test("group connection component stores group connection records and domains", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Acme Corp",
      slug: "acme",
      type: "organization",
    });
  });

  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "acme",
      name: "Acme Corp",
      status: "draft",
      protocol: "saml",
      config: { protocols: { saml: { enabled: true } } },
    });
  });

  const domainId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.domain.create, {
      connectionId,
      groupId,
      domain: "acme.com",
      isPrimary: true,
    });
  });

  const connection = await t.run(async (ctx) => {
    return (await ctx.runQuery(components.auth.connection.get, {
      id: connectionId,
    })) as any;
  });
  // An unverified domain must not resolve to its connection: routing/linking
  // requires a DNS-TXT proof, or any tenant could claim another's domain.
  const lookupBeforeVerify = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.get, {
      domain: "acme.com",
    });
  });
  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.domain.verify, {
      id: domainId,
      verifiedAt: Date.now(),
    });
  });
  const lookup = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.get, {
      domain: "acme.com",
    });
  });
  const domains = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.domain.list, {
      connectionId,
    });
  });
  expect(domainId).toBeDefined();
  expect(connection?.groupId).toBe(groupId);
  expect(lookupBeforeVerify).toBeNull();
  expect((lookup as any)?.connection?._id ?? (lookup as any)?.group?._id).toBe(connectionId);
  expect(domains).toHaveLength(1);
  expect(domains[0]?.isPrimary).toBe(true);
});

test("connection.domain.create keeps a single primary when re-promoting an existing domain", async () => {
  const t = convexTest(schema);
  const groupId = await t.run(async (ctx) =>
    ctx.runMutation(components.auth.group.create, {
      name: "Multi",
      slug: "multi",
      type: "organization",
    }),
  );
  const connectionId = await t.run(async (ctx) =>
    ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "multi",
      name: "Multi",
      status: "draft",
      protocol: "saml",
    }),
  );
  const addDomain = (domain: string) =>
    t.run(async (ctx) =>
      ctx.runMutation(components.auth.connection.domain.create, {
        connectionId,
        groupId,
        domain,
        isPrimary: true,
      }),
    );
  await addDomain("a.example");
  await addDomain("b.example");
  await addDomain("a.example");

  const domains = (await t.run(async (ctx) =>
    ctx.runQuery(components.auth.connection.domain.list, { connectionId }),
  )) as Array<{ domain: string; isPrimary?: boolean }>;
  const primaries = domains.filter((d) => d.isPrimary);
  expect(primaries).toHaveLength(1);
  expect(primaries[0]?.domain).toBe("a.example");
});

test("group connection domain validation reports onboarding diagnostics", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Acme Corp",
      slug: "acme-onboarding",
      type: "organization",
    });
  });

  const created = await t.run(async (ctx) => {
    return await auth.connection.create(ctx as any, {
      groupId,
      slug: "acme-onboarding",
      name: "Acme Onboarding",
      status: "active",
      protocol: "oidc",
    });
  });
  const connectionId = created.connectionId;
  expect(connectionId).toBeTruthy();

  await t.run(async (ctx) => {
    await auth.connection.domain.upsert(ctx as any, {
      connectionId,
      domains: [{ domain: "acme.example", isPrimary: true }],
    });
  });

  const missingVerification = await t.run(async (ctx) => {
    return await auth.connection.domain.validate(ctx as any, { connectionId });
  });

  expect(missingVerification.ready).toBe(false);
  expect(missingVerification.summary.domainCount).toBe(1);
  expect(missingVerification.summary.verifiedCount).toBe(0);
  expect(missingVerification.warnings).toContain("No verified domains yet.");

  const request = await t.run(async (ctx) => {
    return await auth.connection.domain.verification.request(ctx as any, {
      connectionId,
      domain: "acme.example",
    });
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (
        url === "https://dns.google/resolve?name=_convex-auth-verification.acme.example&type=TXT"
      ) {
        return new Response(
          JSON.stringify({
            Answer: [
              {
                name: "_convex-auth-verification.acme.example.",
                type: 16,
                data: `"${request.challenge.recordValue}"`,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const confirmation = await t.run(async (ctx) => {
    return await auth.connection.domain.verification.confirm(ctx as any, {
      connectionId,
      domain: "acme.example",
    });
  });
  expect(confirmation.verifiedAt).toBeDefined();
  expect(confirmation.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);

  const verified = await t.run(async (ctx) => {
    return await auth.connection.domain.validate(ctx as any, { connectionId });
  });

  expect(verified.ready).toBe(true);
  expect(verified.summary.verifiedCount).toBe(1);
  expect(verified.warnings).toHaveLength(0);
});

test("saml metadata parser extracts core IdP details", () => {
  const parsed = parseSamlIdpMetadata(idpMetadataXml);

  expect(parsed.issuer).toBe("https://idp.example.com/metadata");
  expect(parsed.connection.post).toBe("https://idp.example.org/sso/SingleSignOnService");
  expect(parsed.slo.redirect).toBe("https://idp.example.org/sso/SingleLogoutService");
  expect(parsed.wantsSignedAuthnRequests).toBe(true);
  expect(parsed.nameIdFormats.length).toBeGreaterThan(0);
});

test("service provider metadata generation produces group metadata", () => {
  const metadata = createServiceProviderMetadata({
    entityId: "https://app.example.com/connections/acme/saml/metadata",
    acsUrl: "https://app.example.com/connections/acme/saml/acs",
    sloUrl: "https://app.example.com/connections/acme/saml/slo",
    authnRequestsSigned: false,
  });

  expect(metadata).toContain("EntityDescriptor");
  expect(metadata).toContain("https://app.example.com/connections/acme/saml/metadata");
  expect(metadata).toContain("https://app.example.com/connections/acme/saml/acs");
});

test("group connection OIDC validates HS256 ID tokens with client secret", async () => {
  const issuer = "https://idp.example.com";
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const clientId = "test-client-id";
  const clientSecret = "test-client-secret";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === discoveryUrl) {
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            id_token_signing_alg_values_supported: ["HS256"],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === `${issuer}/jwks`) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const mockCtx = {
    runQuery: async () => null,
    runMutation: async () => null,
    runAction: async (_ref: unknown, args: { url: string }) => {
      const response = await fetch(args.url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    },
  };

  try {
    const { oauthConfig } = await createGroupConnectionOidcProvider(
      mockCtx as never,
      { cache: { oidcDiscovery: null } } as never,
      {
        discovery: {
          issuer,
          discoveryUrl,
        },
        client: {
          id: clientId,
          secret: clientSecret,
        },
      },
      "https://app.example.com/connections/example/oidc/callback",
    );

    const nonce = "nonce-123";
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      sub: "user-1",
      nonce,
      email: "user@example.com",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(clientSecret));

    await expect(
      oauthConfig.validateTokens?.(
        {
          idToken,
          accessToken: "access-token",
        },
        { nonce },
      ),
    ).resolves.toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("group connection OIDC profile refuses to run before the id_token is verified", async () => {
  const issuer = "https://idp.example.com";
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === discoveryUrl) {
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            id_token_signing_alg_values_supported: ["RS256"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${issuer}/jwks`) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const mockCtx = {
    runQuery: async () => null,
    runMutation: async () => null,
    runAction: async (_ref: unknown, args: { url: string }) => {
      const response = await fetch(args.url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    },
  };

  try {
    const { oauthConfig } = await createGroupConnectionOidcProvider(
      mockCtx as never,
      { cache: { oidcDiscovery: null } } as never,
      {
        discovery: { issuer, discoveryUrl },
        client: { id: "test-client-id", secret: "test-client-secret" },
      },
      "https://app.example.com/connections/example/oidc/callback",
    );

    await expect(
      oauthConfig.profile({ idToken: "header.payload.signature", accessToken: "access-token" }),
    ).rejects.toThrow(/before the id_token was verified/);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("group connection component stores scim config, audit events, and webhook deliveries", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Globex",
      slug: "globex",
      type: "organization",
    });
  });
  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "globex",
      name: "Globex",
      status: "active",
      protocol: "oidc",
    });
  });

  const configured = await t.run(async (ctx) => {
    return await auth.connection.scim.upsert(ctx, {
      connectionId,
      profile: {
        mapping: {
          email: "emails.primary",
          name: "displayName",
        },
      },
    });
  });
  const scimConfigId = configured.configId;
  const rawToken = configured.token;

  const identityId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId: "scim-user-1",
      active: true,
      raw: { userName: "person@globex.com" },
    });
  });
  const eventId = await t.run(async (ctx) => {
    const result = await auth.event.emit(ctx, {
      kind: "connection.scim.set",
      actor: { type: "system" },
      subject: { type: "connection", id: connectionId },
      targets: [
        { kind: "group", id: groupId },
        { kind: "connection", id: connectionId },
      ],
      outcome: "success",
      data: { scimConfigId },
    });
    return result.eventId;
  });
  const { endpointId } = await t.run(async (ctx) => {
    return await auth.connection.webhook.endpoint.create(ctx, {
      connectionId,
      url: "https://example.com/webhooks/group-connection",
      secret: "secret-hash",
      subscriptions: ["connection.scim.set"],
    });
  });
  await t.run(async (ctx) => {
    const signedAt = Date.now();
    await ctx.runMutation(components.auth.connection.webhook.delivery.create, {
      connectionId,
      endpointId,
      kind: "connection.scim.set",
      eventId,
      payload: { ok: true },
      nextAttemptAt: signedAt,
      signature: "deadbeef",
      signedAt,
    });
  });

  const scimConfig = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.scim.config.get, {
      tokenHash: await sha256(rawToken),
    });
  });
  const identity = await t.run(async (ctx) => {
    return (await ctx.runQuery(components.auth.connection.scim.identity.get, {
      connectionId,
      resourceType: "user",
      externalId: "scim-user-1",
    })) as any;
  });
  const auditEvents = (
    (await t.run(async (ctx) => {
      return await auth.connection.audit.list(ctx, {
        connectionId,
        paginationOpts: { numItems: 10, cursor: null },
      });
    })) as { page: Array<{ kind?: string }> }
  ).page;
  const readyDeliveries = (await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.webhook.delivery.dueForDispatch, {
      now: Date.now(),
      limit: 10,
    });
  })) as Array<{ eventId: string }>;

  const scimGet = (await t.run(async (ctx) => {
    return await auth.connection.scim.get(ctx, { connectionId });
  })) as Record<string, unknown> | null;
  const webhookList = (await t.run(async (ctx) => {
    return await auth.connection.webhook.endpoint.list(ctx, { connectionId });
  })) as Array<Record<string, unknown>>;

  expect(scimConfigId).toBeDefined();
  expect(identityId).toBeDefined();
  expect(endpointId).toBeDefined();
  expect(scimConfig?.connectionId).toBe(connectionId);
  expect(identity?.externalId).toBe("scim-user-1");
  expect(auditEvents.some((event: { kind?: string }) => event.kind === "connection.scim.set")).toBe(
    true,
  );
  expect(
    readyDeliveries.some((delivery: { eventId: string }) => delivery.eventId === eventId),
  ).toBe(true);

  expect(scimGet).not.toBeNull();
  expect(scimGet).not.toHaveProperty("tokenHash");
  expect(scimGet?.hasToken).toBe(true);
  expect(webhookList.length).toBeGreaterThan(0);
  for (const endpoint of webhookList) {
    expect(endpoint).not.toHaveProperty("secretCiphertext");
    expect(endpoint.hasSecret).toBe(true);
  }
});

test("group connection scim identity lookup is scoped to the group connection", async () => {
  const t = convexTest(schema);

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: {
        name: "Shared User",
        email: "shared-scim@example.com",
        emailVerificationTime: Date.now(),
      },
    });
  });

  const first = await t.run(async (ctx) => {
    const groupId = await ctx.runMutation(components.auth.group.create, {
      name: "First Group Connection",
      slug: "first-group-connection",
    });
    const connectionId = await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "first-group-connection",
      name: "First Group Connection",
      status: "active",
      protocol: "oidc",
    });
    await ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId: "first-external-id",
      userId,
      active: true,
    });
    return { connectionId, groupId };
  });

  const second = await t.run(async (ctx) => {
    const groupId = await ctx.runMutation(components.auth.group.create, {
      name: "Second Group Connection",
      slug: "second-group-connection",
    });
    const connectionId = await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "second-group-connection",
      name: "Second Group Connection",
      status: "active",
      protocol: "oidc",
    });
    await ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId: "second-external-id",
      userId,
      active: true,
    });
    return { connectionId, groupId };
  });

  const firstIdentities = (
    await t.run(async (ctx) => {
      return await ctx.runQuery(components.auth.connection.scim.identity.list, {
        connectionId: first.connectionId as any,
        paginationOpts: { numItems: 100, cursor: null },
      });
    })
  ).page;

  const secondIdentities = (
    await t.run(async (ctx) => {
      return await ctx.runQuery(components.auth.connection.scim.identity.list, {
        connectionId: second.connectionId as any,
        paginationOpts: { numItems: 100, cursor: null },
      });
    })
  ).page;

  expect(firstIdentities.find((identity: any) => identity.userId === userId)?.externalId).toBe(
    "first-external-id",
  );
  expect(secondIdentities.find((identity: any) => identity.userId === userId)?.externalId).toBe(
    "second-external-id",
  );
});

test("group connection helper utilities build protocol config and provider ids", () => {
  const nextConfig = upsertProtocolConfig({}, "oidc", {
    discovery: {
      issuer: "https://issuer.example.com",
    },
    client: {
      id: "client_123",
    },
  });

  expect(nextConfig).toEqual({
    protocols: {
      oidc: {
        discovery: {
          issuer: "https://issuer.example.com",
        },
        client: {
          id: "client_123",
        },
      },
    },
  });
  expect(groupOidcProviderId("ent_123")).toBe("group:oidc:ent_123");
  expect(groupSamlProviderId("ent_123")).toBe("group:saml:ent_123");
});

test("group connection route helpers generate clean metadata and callback paths", () => {
  expect(
    getGroupSamlUrls({
      rootUrl: "https://app.example.com",
      source: { kind: "connection", id: "acme" },
    }),
  ).toEqual({
    metadataUrl: "https://app.example.com/connections/acme/saml/metadata",
    acsUrl: "https://app.example.com/connections/acme/saml/acs",
    sloUrl: "https://app.example.com/connections/acme/saml/slo",
  });

  expect(
    getGroupOidcUrls({
      rootUrl: "https://app.example.com",
      connectionId: "acme",
    }),
  ).toEqual({
    signInUrl: "https://app.example.com/connections/acme/oidc/signin",
    callbackUrl: "https://app.example.com/connections/acme/oidc/callback",
  });
});

test("scim list request parsing normalizes pagination and eq filters", () => {
  const url = new URL(
    "https://app.example.com/connections/acme/scim/v2/Users?startIndex=1&count=999&filter=userName%20eq%20%22person@example.com%22",
  );

  expect(parseScimListRequest(url)).toEqual({
    startIndex: 1,
    count: 100,
    filter: {
      attribute: "userName",
      operator: "eq",
      value: "person@example.com",
    },
  });
});

test("group saml source activity is status-gated", () => {
  expect(
    isGroupSamlSourceActive({
      source: { kind: "connection", id: "ent_123" },
      config: {},
      status: "active",
    }),
  ).toBe(true);
  expect(
    isGroupSamlSourceActive({
      source: { kind: "connection", id: "ent_123" },
      config: {},
      status: "draft",
    }),
  ).toBe(false);
});

test("group saml.register persists config directly on group connection", async () => {
  savedEnv.CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = GROUP_CONNECTION_SITE_URL;
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "SAML Register Co",
      slug: "saml-register-co",
      type: "organization",
    });
  });
  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "saml-register-co",
      name: "SAML Register Co",
      status: "active",
      protocol: "saml",
    });
  });

  const completed = await t.run(async (ctx) => {
    const metadataXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/metadata">',
      '  <IDPSSODescriptor WantAuthnRequestsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
      '    <KeyDescriptor use="signing">',
      '      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">',
      "        <ds:X509Data>",
      "          <ds:X509Certificate>MIIBlzCCATACCQC6n5q7Y9qs0DANBgkqhkiG9w0BAQsFADATMREwDwYDVQQDDAhFeGFtcGxlMB4XDTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFowEzERMA8GA1UEAwwIRXhhbXBsZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAxT9F4N8wJ6i9wzV4Yw6n8m2s3mK4n4zQ6xV9S7L0Q2f8oUqg6P5lM4wL6V7I3mQf0Q3Lx1Q2U7Jx7wW0Oe0nM4V0a3mX4H2O1qYv8jGQJ2C1sO8Yf5C8W0w7bP1W0Q1x1uJ0r9tYp8F5s8VY4e1s1M3jJ8n1f3P5wYw3s9QmECAwEAATANBgkqhkiG9w0BAQsFAAOBgQB1u4hM1n6rP5M9w1jQk6R5P0rK4g6fJx7F2mK8nQ2wY8tC1n7xP9sV4kL6mR3yQ0hP2uL8Q4yZ7mS2vX5tN1cF8pG4wK9jL2mQ6rF1sT3uV8xY5zA0nQ6jP4mR2sY8wK5fL1nM7qV3tX6yZ0pR8uH2jK4mN6qP1sT9wY7zF0mQ==</ds:X509Certificate>",
      "        </ds:X509Data>",
      "      </ds:KeyInfo>",
      "    </KeyDescriptor>",
      '    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.org/sso/SingleSignOnService" />',
      '    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.org/sso/SingleLogoutService" />',
      "    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>",
      "  </IDPSSODescriptor>",
      "</EntityDescriptor>",
    ].join("\n");
    return await auth.connection.saml.upsert(ctx as any, {
      connectionId,
      metadata: { xml: metadataXml },
      domains: ["register.example.com"],
      profile: {
        mapping: {
          subject: "UserID",
          email: "Email",
          name: "FullName",
        },
      },
    });
  });

  const connection = await t.run(async (ctx) => {
    return (await ctx.runQuery(components.auth.connection.get, {
      id: connectionId,
    })) as any;
  });
  const domains = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.domain.list, {
      connectionId,
    });
  });
  const auditEvents = (
    await t.run(async (ctx) => {
      return await ctx.runQuery(components.auth.connection.audit.list, {
        connectionId,
        paginationOpts: { numItems: 10, cursor: null },
      });
    })
  ).page;
  const policy = await t.run(async (ctx) => {
    return await auth.connection.policy.get(ctx as any, { groupId });
  });

  expect(completed.connectionId).toBe(connectionId);
  expect(completed.groupId).toBe(groupId);
  expect(connection?.config?.domains).toEqual(["register.example.com"]);
  expect(connection?.config?.protocols?.saml?.idp?.metadataXml).toBeTypeOf("string");
  expect(connection?.config?.protocols?.saml?.profile?.mapping).toEqual({
    subject: "UserID",
    email: "Email",
    name: "FullName",
  });
  expect(connection?.config?.protocols?.saml?.accountLinking).toBeUndefined();
  expect(connection?.config?.protocols?.saml?.reuseScimUserBy).toBeUndefined();
  expect(policy.identity.accountLinking.saml).toBe("sameConnection");
  expect(policy.provisioning.scimReuse.user).toBe("externalId");
  expect(domains[0]?.domain).toBe("register.example.com");
  expect(auditEvents[0]?.kind).toBe("connection.saml.set");
});

test("group policy defaults and updates are normalized through auth.connection.policy", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Policy Co",
      slug: "policy-co",
      type: "organization",
    });
  });
  const defaults = await t.run(async (ctx) => {
    return await auth.connection.policy.get(ctx as any, { groupId });
  });
  const updated = await t.run(async (ctx) => {
    return await auth.connection.policy.update(ctx as any, {
      groupId,
      patch: {
        identity: { accountLinking: { saml: "none" } },
        provisioning: {
          user: {
            updateProfileOnLogin: "always",
            authority: "connection",
          },
          jit: { mode: "createUser", defaultRoleIds: ["orgAdmin"] },
          groups: {
            mode: "sync",
            mapping: { engineering: ["orgAdmin"] },
          },
          roles: {
            mode: "map",
            mapping: { admin: ["orgAdmin"] },
          },
          deprovision: { mode: "hard" },
        },
      },
    });
  });
  const validation = await t.run(async (ctx) => {
    return await auth.connection.policy.validate(ctx as any, { groupId });
  });

  expect(defaults.identity.accountLinking.oidc).toBe("sameConnection");
  expect(defaults.provisioning.user.createOnSignIn).toBe(true);
  expect(defaults.provisioning.user.updateProfileOnLogin).toBe("missing");
  expect(defaults.provisioning.user.updateProfileFromScim).toBe("always");
  expect(defaults.provisioning.user.authority).toBe("app");
  expect(defaults.provisioning.groups.mode).toBe("ignore");
  expect(defaults.provisioning.roles.mode).toBe("ignore");
  expect(defaults.provisioning.deprovision.mode).toBe("soft");
  expect(updated.identity.accountLinking.saml).toBe("none");
  expect(updated.provisioning.user.updateProfileOnLogin).toBe("always");
  expect(updated.provisioning.user.authority).toBe("connection");
  expect(updated.provisioning.jit.mode).toBe("createUser");
  expect(updated.provisioning.jit.defaultRoleIds).toEqual(["orgAdmin"]);
  expect(updated.provisioning.groups.mode).toBe("sync");
  expect(updated.provisioning.groups.mapping).toEqual({
    engineering: ["orgAdmin"],
  });
  expect(updated.provisioning.roles.mode).toBe("map");
  expect(updated.provisioning.roles.mapping).toEqual({
    admin: ["orgAdmin"],
  });
  expect(updated.provisioning.deprovision.mode).toBe("hard");
  expect(validation.ok).toBe(true);
});

test("group connection domain status exposes trust and next steps", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Status Co",
      slug: "status-co",
      type: "organization",
    });
  });

  const { connectionId } = await t.run(async (ctx) => {
    return await auth.connection.create(ctx as any, {
      groupId,
      name: "Status Co OIDC",
      protocol: "oidc",
      status: "active",
    });
  });

  await t.run(async (ctx) => {
    await auth.connection.domain.upsert(ctx as any, {
      connectionId,
      domains: [{ domain: "status.example.com", isPrimary: true }],
    });
  });

  const initial = await t.run(async (ctx) => {
    return await auth.connection.domain.status(ctx as any, { connectionId });
  });

  expect(initial.primaryDomain?.domain).toBe("status.example.com");
  expect(initial.trust.primaryDomainVerified).toBe(false);
  expect(initial.trust.automaticLinkingEligible).toBe(false);
  expect(initial.nextSteps).toContain(
    "Request a TXT challenge and confirm verification for at least one domain.",
  );

  const requested = await t.run(async (ctx) => {
    return await auth.connection.domain.verification.request(ctx as any, {
      connectionId,
      domain: "status.example.com",
    });
  });

  const withChallenge = await t.run(async (ctx) => {
    return await auth.connection.domain.status(ctx as any, { connectionId });
  });

  expect(withChallenge.pendingChallenges).toHaveLength(1);
  expect(withChallenge.pendingChallenges[0]?.recordName).toBe(requested.challenge.recordName);
});

test("group oidc.register merges config and client.signIn requires verified domains for domain lookup", async () => {
  savedEnv.CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = GROUP_CONNECTION_SITE_URL;
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "OIDC Co",
      slug: "oidc-co",
      type: "organization",
    });
  });
  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "oidc-co",
      name: "OIDC Co",
      status: "active",
      protocol: "oidc",
      config: { protocols: { saml: { enabled: true } } },
    });
  });
  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.domain.create, {
      connectionId,
      groupId,
      domain: "oidc.example.com",
      isPrimary: true,
    });
  });

  const oidcConfig = await t.run(async (ctx) => {
    return await auth.connection.oidc.upsert(ctx as any, {
      connectionId,
      discovery: {
        issuer: "https://issuer.example.com",
        discoveryUrl: "https://issuer.example.com/.well-known/openid-configuration",
        audience: ["client_123", "api://groups"],
        jwksUri: "https://issuer.example.com/jwks",
      },
      client: {
        id: "client_123",
        secret: "secret_123",
        authMethod: "client_secret_basic",
      },
      request: {
        scopes: ["openid", "email"],
        loginHint: "admin@oidc.example.com",
        authorizationParams: { prompt: "login" },
      },
      profile: {
        mapping: {
          email: "preferred_username",
          name: "display_name",
        },
      },
    });
  });

  const connection = await t.run(async (ctx) => {
    return (await ctx.runQuery(components.auth.connection.get, {
      id: connectionId,
    })) as any;
  });
  const secret = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.secret.get, {
      connectionId,
      kind: "oidc_client_secret",
    } as any);
  });
  const auditEvents = (
    await t.run(async (ctx) => {
      return await ctx.runQuery(components.auth.connection.audit.list, {
        connectionId,
        paginationOpts: { numItems: 10, cursor: null },
      });
    })
  ).page;
  const explicitResolved = await t.run(async (ctx) => {
    return await auth.connection.signIn(ctx as any, {
      connectionId,
      redirectTo: "/dashboard",
      loginHint: "admin@oidc.example.com",
    });
  });
  await expect(
    t.run(async (ctx) => {
      return await auth.connection.signIn(ctx as any, {
        domain: "oidc.example.com",
        redirectTo: "/dashboard",
        loginHint: "admin@oidc.example.com",
      });
    }),
  ).rejects.toThrow("No group connection matched the provided input.");

  const request = await t.run(async (ctx) => {
    return await auth.connection.domain.verification.request(ctx as any, {
      connectionId,
      domain: "oidc.example.com",
    });
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (
        url ===
        "https://dns.google/resolve?name=_convex-auth-verification.oidc.example.com&type=TXT"
      ) {
        return new Response(
          JSON.stringify({
            Answer: [
              {
                name: "_convex-auth-verification.oidc.example.com.",
                type: 16,
                data: `"${request.challenge.recordValue}"`,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const confirmation = await t.run(async (ctx) => {
    return await auth.connection.domain.verification.confirm(ctx as any, {
      connectionId,
      domain: "oidc.example.com",
    });
  });

  const resolved = await t.run(async (ctx) => {
    return await auth.connection.signIn(ctx as any, {
      domain: "oidc.example.com",
      redirectTo: "/dashboard",
      loginHint: "admin@oidc.example.com",
    });
  });
  const clientResolved = await t.query(api.auth.group.signIn, {
    domain: "oidc.example.com",
    redirectTo: "/dashboard",
    loginHint: "admin@oidc.example.com",
  });

  expect(oidcConfig.hasClientSecret).toBe(true);
  expect(connection?.config?.protocols?.saml?.enabled).toBe(true);
  expect(connection?.config?.protocols?.oidc?.discovery?.issuer).toBe("https://issuer.example.com");
  expect(connection?.config?.protocols?.oidc?.discovery?.jwksUri).toBe(
    "https://issuer.example.com/jwks",
  );
  expect(connection?.config?.protocols?.oidc?.client?.authMethod).toBe("client_secret_basic");
  expect(connection?.config?.protocols?.oidc?.request?.loginHint).toBe("admin@oidc.example.com");
  expect(connection?.config?.protocols?.oidc?.client?.secret).toBeUndefined();
  expect(secret?.ciphertext).toBeDefined();
  const oidcAuditEvent = auditEvents.find((event: any) => event.kind === "connection.oidc.set");
  expect(oidcAuditEvent?.kind).toBe("connection.oidc.set");
  const oidcAuditData = oidcAuditEvent?.data as { issuer?: string; jwksUri?: string } | undefined;
  expect(oidcAuditData?.issuer).toBe("https://issuer.example.com");
  expect(oidcAuditData?.jwksUri).toBe("https://issuer.example.com/jwks");
  expect(explicitResolved.providerId).toBe("group:oidc:" + connectionId);
  expect(confirmation.verifiedAt).toBeDefined();
  expect(confirmation.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
  expect(resolved.providerId).toBe("group:oidc:" + connectionId);
  expect(resolved.signInPath).toBe(
    `${GROUP_CONNECTION_AUTH_SITE_URL}/connections/${connectionId}/oidc/signin?loginHint=admin%40oidc.example.com`,
  );
  expect(resolved.callbackPath).toBe(
    `${GROUP_CONNECTION_AUTH_SITE_URL}/connections/${connectionId}/oidc/callback`,
  );
  expect(resolved.redirectTo).toBe("/dashboard");
  expect(clientResolved).toEqual(resolved);
  expect((oidcConfig as { client?: { secret?: string } }).client?.secret).toBeUndefined();
});

test("public group connection OIDC config omits client secret", () => {
  const config = getPublicOidcConfig({
    protocols: {
      oidc: {
        enabled: true,
        discovery: {
          issuer: "https://issuer.example.com",
        },
        client: {
          id: "client_123",
          secret: "secret_123",
        },
      },
    },
  });

  expect((config.client as { id?: string } | undefined)?.id).toBe("client_123");
  expect((config.client as { secret?: string } | undefined)?.secret).toBeUndefined();
});

test("public group connection SAML config omits the service-provider private key", () => {
  const config = getPublicSamlConfig({
    protocols: {
      saml: {
        enabled: true,
        idp: { entityId: "https://idp.example.com/metadata" },
        serviceProvider: {
          entityId: "https://sp.example.com",
          signingCert: "PUBLIC-CERT",
          privateKey: "PRIVATE-KEY",
          privateKeyPass: "PRIVATE-PASS",
          encPrivateKey: "ENC-PRIVATE-KEY",
          encPrivateKeyPass: "ENC-PRIVATE-PASS",
        },
      },
    },
  });

  const sp = config.serviceProvider as Record<string, unknown> | undefined;
  expect(sp?.entityId).toBe("https://sp.example.com");
  expect(sp?.signingCert).toBe("PUBLIC-CERT");
  expect(sp?.privateKey).toBeUndefined();
  expect(sp?.privateKeyPass).toBeUndefined();
  expect(sp?.encPrivateKey).toBeUndefined();
  expect(sp?.encPrivateKeyPass).toBeUndefined();

  const arrayShaped = getPublicSamlConfig({
    protocols: { saml: { serviceProvider: ["PRIVATE-KEY"] } },
  });
  expect(JSON.stringify(arrayShaped)).not.toContain("PRIVATE-KEY");
  expect(arrayShaped.serviceProvider).toBeUndefined();
});

test("public connection config strips both the OIDC client secret and the SAML private key", () => {
  const config = getPublicConnectionConfig({
    protocols: {
      oidc: { client: { id: "client_123", secret: "oidc-secret" } },
      saml: { serviceProvider: { entityId: "https://sp.example.com", privateKey: "saml-private" } },
    },
  });

  const protocols = config.protocols as {
    oidc?: { client?: { id?: string; secret?: string } };
    saml?: { serviceProvider?: { entityId?: string; privateKey?: string } };
  };
  expect(protocols.oidc?.client?.id).toBe("client_123");
  expect(protocols.oidc?.client?.secret).toBeUndefined();
  expect(protocols.saml?.serviceProvider?.entityId).toBe("https://sp.example.com");
  expect(protocols.saml?.serviceProvider?.privateKey).toBeUndefined();
});

test("connection read facade redacts the SAML SP private key on get, saml.get, and list", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Redact Co",
      slug: "redact-co",
      type: "organization",
    });
  });
  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "redact-co",
      name: "Redact Co",
      status: "active",
      protocol: "saml",
      config: {
        protocols: {
          saml: {
            enabled: true,
            idp: { entityId: "https://idp.example.com/metadata" },
            serviceProvider: {
              entityId: "https://sp.example.com",
              signingCert: "PUBLIC-CERT",
              privateKey: "PRIVATE-KEY",
              privateKeyPass: "PRIVATE-PASS",
              encPrivateKey: "ENC-PRIVATE-KEY",
              encPrivateKeyPass: "ENC-PRIVATE-PASS",
            },
          },
        },
      },
    });
  });

  const viaGet = (await t.run(async (ctx) => {
    return await auth.connection.get(ctx as any, { id: connectionId });
  })) as any;
  const viaSaml = (await t.run(async (ctx) => {
    return await auth.connection.saml.get(ctx as any, { connectionId });
  })) as any;
  const viaList = (await t.run(async (ctx) => {
    return await auth.connection.list(ctx as any, {
      where: { groupId },
      paginationOpts: { numItems: 10, cursor: null },
    });
  })) as any;

  const getSp = viaGet?.config?.protocols?.saml?.serviceProvider;
  expect(getSp?.entityId).toBe("https://sp.example.com");
  expect(getSp?.signingCert).toBe("PUBLIC-CERT");
  expect(getSp?.privateKey).toBeUndefined();
  expect(getSp?.encPrivateKey).toBeUndefined();

  expect(viaSaml?.serviceProvider?.entityId).toBe("https://sp.example.com");
  expect(viaSaml?.serviceProvider?.privateKey).toBeUndefined();
  expect(viaSaml?.serviceProvider?.privateKeyPass).toBeUndefined();
  expect(viaSaml?.serviceProvider?.encPrivateKey).toBeUndefined();
  expect(viaSaml?.serviceProvider?.encPrivateKeyPass).toBeUndefined();

  const listSp = viaList.page.find((row: any) => row._id === connectionId)?.config?.protocols?.saml
    ?.serviceProvider;
  expect(listSp?.entityId).toBe("https://sp.example.com");
  expect(listSp?.privateKey).toBeUndefined();
});

test("removing a connection cascades scim config, identities, webhook endpoints and deliveries", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Cascade Co",
      slug: "cascade-co",
      type: "organization",
    });
  });
  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "cascade-co",
      name: "Cascade Co",
      status: "active",
      protocol: "oidc",
    });
  });

  const configured = await t.run(async (ctx) => {
    return await auth.connection.scim.upsert(ctx as any, {
      connectionId,
      profile: { mapping: { email: "emails.primary" } },
    });
  });
  const tokenHash = await sha256(configured.token);

  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId: "cascade-user-1",
      active: true,
    });
  });
  const endpointId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.webhook.endpoint.create, {
      connectionId,
      groupId,
      url: "https://hooks.example.com/cascade",
      status: "active",
      secretCiphertext: await encryptSecret("secret"),
      subscriptions: ["connection.scim.set"],
    } as any);
  });
  await t.run(async (ctx) => {
    const signedAt = Date.now();
    await ctx.runMutation(components.auth.connection.webhook.delivery.create, {
      connectionId,
      endpointId,
      kind: "connection.scim.set",
      eventId: "cascade-event-1",
      payload: { ok: true },
      nextAttemptAt: signedAt,
      signature: "deadbeef",
      signedAt,
    });
  });
  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.domain.create, {
      connectionId,
      groupId,
      domain: "cascade.example.com",
      isPrimary: true,
    });
  });

  await t.run(async (ctx) => {
    await auth.connection.remove(ctx as any, { id: connectionId });
  });

  const connection = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.get, { id: connectionId });
  });
  const scimConfig = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.scim.config.get, { tokenHash });
  });
  const identities = (
    await t.run(async (ctx) => {
      return await ctx.runQuery(components.auth.connection.scim.identity.list, {
        connectionId,
        paginationOpts: { numItems: 100, cursor: null },
      });
    })
  ).page;
  const endpoints = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.webhook.endpoint.list, { connectionId });
  });
  const domains = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.domain.list, { connectionId });
  });
  const deliveries = (
    (await t.run(async (ctx) => {
      return await ctx.runQuery(components.auth.connection.webhook.delivery.dueForDispatch, {
        now: Date.now() + 60_000,
        limit: 100,
      });
    })) as Array<{ connectionId: string }>
  ).filter((delivery) => delivery.connectionId === connectionId);

  expect(connection).toBeNull();
  expect(scimConfig).toBeNull();
  expect(identities).toHaveLength(0);
  expect(endpoints).toHaveLength(0);
  expect(domains).toHaveLength(0);
  expect(deliveries).toHaveLength(0);
});

test("group OIDC shared callback helpers resolve stable callback URL and state", () => {
  const urls = getGroupOidcUrls({
    rootUrl: GROUP_CONNECTION_SITE_URL,
    connectionId: "conn_123",
    sharedRedirectURI: "/connection/callback",
  });

  expect(urls.signInUrl).toBe(`${GROUP_CONNECTION_SITE_URL}/connections/conn_123/oidc/signin`);
  expect(urls.callbackUrl).toBe(`${GROUP_CONNECTION_SITE_URL}/connection/callback`);

  const encoded = encodeGroupOidcState({
    connectionId: "conn_123",
    state: "state_abc",
  });

  expect(decodeGroupOidcState(encoded)).toEqual({
    connectionId: "conn_123",
    state: "state_abc",
  });
});

test("policy role resolution combines jit defaults with mapped groups and roles", () => {
  const roleIds = resolveProvisionedRoleIds({
    policy: {
      version: 1,
      identity: {
        accountLinking: { oidc: "verifiedEmail", saml: "verifiedEmail" },
      },
      provisioning: {
        user: {
          createOnSignIn: true,
          updateProfileOnLogin: "missing",
          updateProfileFromScim: "always",
          authority: "app",
        },
        scimReuse: { user: "externalId" },
        jit: { mode: "createUserAndMembership", defaultRoleIds: ["member"] },
        deprovision: { mode: "soft" },
        groups: {
          mode: "sync",
          source: "protocol",
          mapping: { engineering: ["engineer"] },
        },
        roles: {
          mode: "map",
          source: "protocol",
          mapping: { admin: ["orgAdmin"] },
        },
      },
    },
    groups: ["engineering"],
    roles: ["admin"],
  });

  expect(roleIds.sort()).toEqual(["engineer", "member", "orgAdmin"]);
});

test("provisioned membership stores resolved roleIds queryable via memberGetByGroupAndUser", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Role Assert Co",
      slug: "role-assert-co",
      type: "organization",
    });
  });

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "role-assert-conn",
      name: "Role Assert Connection",
      status: "active",
      protocol: "oidc",
    });
  });

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: {
        name: "Role User",
        email: "role-user@example.com",
        emailVerificationTime: Date.now(),
      },
    });
  });

  const resolvedRoleIds = resolveProvisionedRoleIds({
    policy: {
      version: 1,
      identity: {
        accountLinking: { oidc: "verifiedEmail", saml: "verifiedEmail" },
      },
      provisioning: {
        user: {
          createOnSignIn: true,
          updateProfileOnLogin: "missing",
          updateProfileFromScim: "always",
          authority: "app",
        },
        scimReuse: { user: "externalId" },
        jit: { mode: "createUserAndMembership", defaultRoleIds: ["member"] },
        deprovision: { mode: "soft" },
        groups: {
          mode: "sync",
          source: "protocol",
          mapping: { engineering: ["engineer"] },
        },
        roles: {
          mode: "map",
          source: "protocol",
          mapping: { admin: ["orgAdmin"] },
        },
      },
    },
    groups: ["engineering"],
    roles: ["admin"],
  });

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.member.create, {
      groupId,
      userId,
      roleIds: resolvedRoleIds,
      status: "active",
    });
  });

  const membership = await t.run(async (ctx) => {
    return (await ctx.runQuery(components.auth.group.member.get, {
      groupId,
      userId,
    })) as any;
  });

  expect(membership).not.toBeNull();
  expect(membership?.roleIds?.sort()).toEqual(["engineer", "member", "orgAdmin"]);
});

test("Connection hooks can transform normalized profiles", async () => {
  const hookCalls: Array<{ phase: string; protocol: string }> = [];
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Hooks Co",
      slug: "hooks-co",
      type: "organization",
    });
  });

  const { connectionId } = await t.run(async (ctx) => {
    return await auth.connection.create(ctx as any, {
      groupId,
      name: "Hooks OIDC",
      protocol: "oidc",
      status: "active",
    });
  });

  const profile = {
    id: "sub-123",
    email: "hook@example.com",
    name: "Original",
    groups: ["engineering"],
    roles: ["admin"],
  };

  const profileResolved = {
    ...profile,
    name: "Resolved",
  };

  const beforeProvision = {
    ...profileResolved,
    extend: { department: "Engineering" },
  };

  const hooks = {
    profileResolved: async ({ protocol }: any) => {
      hookCalls.push({ phase: "profileResolved", protocol });
      return profileResolved;
    },
    beforeProvision: async ({ protocol }: any) => {
      hookCalls.push({ phase: "beforeProvision", protocol });
      return beforeProvision;
    },
    afterProvision: async ({ protocol }: any) => {
      hookCalls.push({ phase: "afterProvision", protocol });
    },
  };

  await t.run(async (ctx) => {
    await auth.connection.scim.upsert(ctx as any, {
      connectionId,
      profile: {
        mapping: {
          email: "userName",
          name: "displayName",
          groups: "groups",
          roles: "roles",
        },
      },
    });

    const resolved =
      (await hooks.profileResolved({
        protocol: "scim",
        connectionId,
        profile,
      })) ?? profile;
    const prepared =
      (await hooks.beforeProvision({
        protocol: "scim",
        connectionId,
        profile: resolved,
      })) ?? resolved;
    expect(prepared.name).toBe("Resolved");
    expect((prepared as any).extend.department).toBe("Engineering");
    await hooks.afterProvision({
      protocol: "scim",
      connectionId,
      profile: prepared,
      userId: "user_123",
    });
  });

  expect(hookCalls).toEqual([
    { phase: "profileResolved", protocol: "scim" },
    { phase: "beforeProvision", protocol: "scim" },
    { phase: "afterProvision", protocol: "scim" },
  ]);
});

test("SAML security can require signed assertions", () => {
  expect(() =>
    enforceGroupConnectionSamlSecurity({
      extract: {
        response: { signatureAlgorithm: "rsa-sha256" },
      },
      config: {
        protocols: {
          saml: {
            security: { requireSignedAssertions: true },
          },
        },
      },
    }),
  ).toThrow("SAML assertion must be signed.");
});

test("SAML security can require timestamps", () => {
  expect(() =>
    enforceGroupConnectionSamlSecurity({
      extract: {
        signature: { signatureAlgorithm: "rsa-sha256" },
      },
      config: {
        protocols: {
          saml: {
            security: { requireTimestamps: true },
          },
        },
      },
    }),
  ).toThrow("missing a validity window");
});

test("SAML security respects configured clock skew for assertion timestamps", () => {
  const soon = new Date(Date.now() + 30_000).toISOString();
  expect(() =>
    enforceGroupConnectionSamlSecurity({
      extract: {
        signature: { signatureAlgorithm: "rsa-sha256" },
        conditions: { notBefore: soon },
      },
      config: {
        protocols: {
          saml: {
            security: { requireTimestamps: true, clockSkewSeconds: 60 },
          },
        },
      },
    }),
  ).toThrow("missing a validity window");
});

test("SAML security can reject weak algorithms", () => {
  expect(() =>
    enforceSamlAlgorithmPolicy({
      extract: {
        signature: {
          signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
        },
      },
      config: {
        protocols: {
          saml: {
            security: { weakAlgorithmHandling: "reject" },
          },
        },
      },
    }),
  ).toThrow("SAML response uses a rejected weak cryptographic algorithm.");
});

test("SAML metadata size limit is enforced", () => {
  expect(() =>
    enforceSamlMetadataSize({
      metadataXml: "x".repeat(11),
      config: {
        protocols: {
          saml: {
            security: { maxMetadataSize: 10 },
          },
        },
      },
    }),
  ).toThrow("SAML metadata exceeds the configured size limit.");
});

test("SAML response size limit is enforced", () => {
  expect(() =>
    enforceSamlResponseSize({
      request: {
        url: new URL("https://example.com"),
        body: { SAMLResponse: "x".repeat(11) },
        query: {},
        binding: "post",
        relayState: undefined,
        hasSamlRequest: false,
        hasSamlResponse: true,
      },
      config: {
        protocols: {
          saml: {
            security: { maxResponseSize: 10 },
          },
        },
      },
    }),
  ).toThrow("SAML response exceeds the configured size limit.");
});

test("group connection scim.configure stores hashed token and enqueues subscribed deliveries", async () => {
  savedEnv.CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = GROUP_CONNECTION_SITE_URL;
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "SCIM Corp",
      slug: "scim-corp",
      type: "organization",
    });
  });
  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "scim-corp",
      name: "SCIM Corp",
      status: "active",
      protocol: "oidc",
    });
  });
  const ciphertextA = await encryptSecret("secret-a");
  const ciphertextB = await encryptSecret("secret-b");
  const ciphertextC = await encryptSecret("secret-c");
  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.webhook.endpoint.create, {
      connectionId,
      groupId,
      url: "https://hooks.example.com/a",
      status: "active",
      secretCiphertext: ciphertextA,
      subscriptions: ["connection.scim.set"],
    } as any);
    await ctx.runMutation(components.auth.connection.webhook.endpoint.create, {
      connectionId,
      groupId,
      url: "https://hooks.example.com/b",
      status: "disabled",
      secretCiphertext: ciphertextB,
      subscriptions: ["connection.scim.set"],
    } as any);
    await ctx.runMutation(components.auth.connection.webhook.endpoint.create, {
      connectionId,
      groupId,
      url: "https://hooks.example.com/c",
      status: "active",
      secretCiphertext: ciphertextC,
      subscriptions: ["connection.oidc.set"],
    } as any);
  });

  const configured = await t.run(async (ctx) => {
    return await auth.connection.scim.upsert(ctx as any, {
      connectionId,
      security: { maxRequestSize: 200_000 },
      profile: {
        mapping: {
          email: "emails.primary",
          active: "active",
        },
      },
    });
  });

  const scimConfig = await t.run(async (ctx) => {
    return await auth.connection.scim.get(ctx as any, { connectionId });
  });
  const lookedUpByToken = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.scim.config.get, {
      tokenHash: await sha256(configured.token),
    });
  });
  const policy = await t.run(async (ctx) => {
    return await auth.connection.policy.get(ctx as any, { groupId });
  });

  expect(scimConfig?.security?.maxRequestSize).toBe(200_000);
  expect(scimConfig?.profile?.mapping?.email).toBe("emails.primary");
  expect(scimConfig?.profile?.mapping?.active).toBe("active");
  const auditEvents = (
    await t.run(async (ctx) => {
      return await ctx.runQuery(components.auth.connection.audit.list, {
        connectionId,
        paginationOpts: { numItems: 10, cursor: null },
      });
    })
  ).page;
  const deliveries = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.webhook.delivery.dueForDispatch, {
      now: Date.now(),
      limit: 10,
    });
  });

  expect(configured.token).toBeTruthy();
  expect(scimConfig?.hasToken).toBe(true);
  expect(scimConfig).not.toHaveProperty("tokenHash");
  expect(scimConfig?.basePath).toBe(
    `${GROUP_CONNECTION_AUTH_SITE_URL}/connections/${connectionId}/scim/v2`,
  );
  expect(policy.provisioning.deprovision.mode).toBe("soft");
  expect(lookedUpByToken?._id).toBe(scimConfig?._id);
  expect(auditEvents.some((event: any) => event.kind === "connection.scim.set")).toBe(true);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.connectionId).toBe(connectionId);
});
