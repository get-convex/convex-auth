/**
 * SCIM Interoperability Tests
 *
 * Lane 1 – SCIM → ZITADEL
 *   Provision users into ZITADEL over its own SCIM v2 interface and verify
 *   identity lifecycle (create / read / filter / deactivate / reactivate /
 *   delete). Later combined tests (SCIM + OIDC) live in combined/node.test.ts.
 *
 * Lane 2 – SCIM → Convex
 *   Directly exercise the Convex group connection SCIM server using plain HTTP with
 *   strict SCIM-compliant request/response assertions. Exposes protocol gaps
 *   (meta fields, pagination, filter semantics) for incremental remediation.
 */

import { randomBytes } from "node:crypto";

import { api } from "@convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { expect, test } from "vite-plus/test";

import {
  type ConvexSignInResult,
  getInteropRuntime,
  groupAuditListRpc,
  groupCreateRpc,
  groupConnectionCreateRpc,
  groupConnectionScimConfigureRpc,
  groupWebhookEndpointListRpc,
  groupWebhookDeliveryListRpc,
  groupWebhookEndpointCreateRpc,
  randomSlug,
  requestHttp,
  requestJson,
} from "../helpers.js";

type ScimUser = {
  id?: string;
  externalId?: string;
  userName?: string;
  displayName?: string;
  active?: boolean;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: { value: string; primary?: boolean }[];
  meta?: { location?: string; resourceType?: string };
  schemas?: string[];
};

type ScimListResponse<T> = {
  schemas?: string[];
  totalResults?: number;
  startIndex?: number;
  itemsPerPage?: number;
  Resources?: T[];
};

type ScimGroup = {
  id?: string;
  externalId?: string;
  displayName?: string;
  members?: { value: string }[];
  meta?: { location?: string; resourceType?: string };
  schemas?: string[];
};

type GroupWebhookEndpoint = {
  _id?: string;
  connectionId?: string;
  url?: string;
  status?: string;
  subscriptions?: string[];
  secretHash?: string;
};

type GroupWebhookDelivery = {
  _id?: string;
  eventId: string;
  kind?: string;
  endpointId?: string;
  connectionId?: string;
  status?: string;
};

type AuthEventProjection = {
  _id?: string;
  kind?: string;
  outcome?: string;
  subjectId?: string;
  subjectType?: string;
};

async function scimRequest<T>(
  base: string,
  path: string,
  token: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; headers: Headers; body: T }> {
  const method = opts.method ?? "GET";
  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/scim+json",
  };
  if (bodyStr !== undefined) headers["Content-Type"] = "application/scim+json";
  const res = await requestHttp(`${base}${path}`, {
    method,
    headers,
    body: bodyStr,
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, headers: res.headers, body };
}

test("SCIM → ZITADEL: provision and manage user lifecycle", async () => {
  const { zitadelBaseUrl, managementToken } = getInteropRuntime();

  const orgRes = await requestJson<{ org: { id: string } }>(
    `${zitadelBaseUrl}/management/v1/orgs/me`,
    { headers: { Authorization: `Bearer ${managementToken}` } },
  );
  const orgId = orgRes.org.id;
  expect(orgId).toBeTruthy();

  const base = `${zitadelBaseUrl}/scim/v2/${orgId}`;
  const runId = randomSlug("scim-zitadel");
  const externalId = `ext-${runId}`;
  const userEmail = `${runId}@example.com`;
  const userPassword = `Scim-${randomBytes(6).toString("hex")}!`;

  const spcRes = await scimRequest<{
    schemas?: string[];
    patch?: { supported: boolean };
  }>(base, "/ServiceProviderConfig", managementToken);
  expect(spcRes.status).toBe(200);
  expect(spcRes.body.schemas).toContain(
    "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  );
  expect(spcRes.body.patch?.supported).toBe(true);

  const createRes = await scimRequest<ScimUser>(base, "/Users", managementToken, {
    method: "POST",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId,
      userName: runId,
      name: { givenName: "SCIM", familyName: "User" },
      emails: [{ value: userEmail, primary: true }],
      password: userPassword,
      active: true,
    },
  });
  expect(createRes.status).toBe(201);
  const userId = createRes.body.id!;
  expect(userId).toBeTruthy();
  expect(createRes.body.externalId).toBe(externalId);
  expect(createRes.body.active).toBe(true);

  await new Promise((r) => setTimeout(r, 500));
  const getRes = await scimRequest<ScimUser>(base, `/Users/${userId}`, managementToken);
  expect(getRes.status).toBe(200);
  expect(getRes.body.id).toBe(userId);
  expect(getRes.body.userName).toBe(runId);

  const filterRes = await scimRequest<ScimListResponse<ScimUser>>(
    base,
    `/Users?filter=${encodeURIComponent(`externalId eq "${externalId}"`)}`,
    managementToken,
  );
  expect(filterRes.status).toBe(200);
  expect((filterRes.body.totalResults ?? 0) >= 1).toBe(true);
  expect((filterRes.body.Resources ?? []).some((u) => u.id === userId)).toBe(true);

  const deactivateRes = await scimRequest<unknown>(base, `/Users/${userId}`, managementToken, {
    method: "PATCH",
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    },
  });
  expect([200, 204]).toContain(deactivateRes.status);

  const reactivateRes = await scimRequest<unknown>(base, `/Users/${userId}`, managementToken, {
    method: "PATCH",
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: true }],
    },
  });
  expect([200, 204]).toContain(reactivateRes.status);

  const deleteRes = await scimRequest<unknown>(base, `/Users/${userId}`, managementToken, {
    method: "DELETE",
  });
  expect(deleteRes.status).toBe(204);
}, 60_000);

test("SCIM → Convex: direct SCIM server protocol validation", async () => {
  const { convexApiUrl, convexSiteUrl } = getInteropRuntime();

  const convexClient = new ConvexHttpClient(convexApiUrl, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  });
  const signInResult = (await convexClient.action(api.auth.signIn, {
    provider: "anonymous",
  })) as ConvexSignInResult;
  expect(signInResult.kind).toBe("signedIn");
  const convexUserToken = signInResult.session?.token;
  expect(convexUserToken).toBeTruthy();
  if (!convexUserToken) {
    throw new Error("Anonymous sign-in did not return a user token.");
  }

  const runId = randomSlug("scim-convex");
  const { groupId } = await groupCreateRpc(convexClient, convexUserToken, {
    name: `SCIM Convex ${runId}`,
  });
  const connectionCreated = await groupConnectionCreateRpc(convexClient, convexUserToken, {
    groupId,
    name: `SCIM Convex ${runId}`,
    slug: runId,
    protocol: "oidc",
    status: "active",
  });
  const connectionId = connectionCreated.connectionId;
  expect(connectionId).toBeTruthy();

  const webhookCreated = (await groupWebhookEndpointCreateRpc(convexClient, convexUserToken, {
    connectionId,
    url: `https://example.com/webhooks/${runId}`,
    secret: "super-secret",
    subscriptions: [
      "connection.scim.set",
      "connection.scim.user.provisioned",
      "connection.scim.user.updated",
      "connection.scim.user.deactivated",
      "connection.scim.group.provisioned",
      "connection.scim.group.updated",
    ],
  })) as GroupWebhookEndpoint;
  expect(webhookCreated._id).toBeTruthy();
  expect(webhookCreated.url).toBe(`https://example.com/webhooks/${runId}`);
  expect(webhookCreated.secretHash).toBeUndefined();

  const scimConfigured = await groupConnectionScimConfigureRpc(convexClient, convexUserToken, {
    connectionId,
    profile: {
      mapping: {
        email: "userName",
        name: "displayName",
      },
      extraFields: {
        department: "department",
      },
    },
  });
  const scimToken = scimConfigured.token!;
  expect(scimToken).toBeTruthy();

  const base = `${convexSiteUrl}/connections/${connectionId}/scim/v2`;
  expect(scimConfigured.basePath).toBe(base);

  const spcRes = await scimRequest<{
    schemas?: string[];
    patch?: { supported: boolean };
    filter?: { supported: boolean };
  }>(base, "/ServiceProviderConfig", scimToken);
  expect(spcRes.status).toBe(200);
  expect(spcRes.body.schemas).toContain(
    "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  );
  expect(spcRes.body.patch?.supported).toBe(true);

  const schemasRes = await scimRequest<ScimListResponse<{ id?: string }>>(
    base,
    "/Schemas",
    scimToken,
  );
  expect(schemasRes.status).toBe(200);
  expect(schemasRes.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");

  const rtRes = await scimRequest<ScimListResponse<{ name?: string }>>(
    base,
    "/ResourceTypes",
    scimToken,
  );
  expect(rtRes.status).toBe(200);
  expect(rtRes.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");

  const externalId = `ext-${runId}`;
  const userEmail = `${runId}@example.com`;

  const createRes = await scimRequest<ScimUser>(base, "/Users", scimToken, {
    method: "POST",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId,
      userName: userEmail,
      displayName: "SCIM Test User",
      department: "Engineering",
      name: { givenName: "SCIM", familyName: "Test" },
      emails: [{ value: userEmail, primary: true }],
      active: true,
    },
  });
  expect(createRes.status).toBe(201);
  const userId = createRes.body.id!;
  expect(userId).toBeTruthy();
  expect(createRes.body.schemas).toContain("urn:ietf:params:scim:schemas:core:2.0:User");
  expect(createRes.body.externalId).toBe(externalId);
  expect(createRes.body.active).toBe(true);
  expect(createRes.body.displayName).toBe("SCIM Test User");
  expect(createRes.body.meta?.resourceType).toBe("User");
  expect(createRes.body.meta?.location).toBe(`${base}/Users/${userId}`);
  expect(createRes.headers.get("location")).toBe(`${base}/Users/${userId}`);

  const createRetryRes = await scimRequest<ScimUser>(base, "/Users", scimToken, {
    method: "POST",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId,
      userName: userEmail,
      name: { givenName: "Retry", familyName: "User" },
      emails: [{ value: userEmail, primary: true }],
      active: true,
    },
  });
  expect(createRetryRes.status).toBe(200);
  expect(createRetryRes.body.id).toBe(userId);

  const getRes = await scimRequest<ScimUser>(base, `/Users/${userId}`, scimToken);
  expect(getRes.status).toBe(200);
  expect(getRes.body.id).toBe(userId);
  expect(getRes.body.userName).toBe(userEmail);
  expect(getRes.body.meta?.resourceType).toBe("User");
  expect(getRes.body.meta?.location).toBe(`${base}/Users/${userId}`);
  expect(getRes.headers.get("location")).toBe(`${base}/Users/${userId}`);

  const filterRes = await scimRequest<ScimListResponse<ScimUser>>(
    base,
    `/Users?filter=${encodeURIComponent(`externalId eq "${externalId}"`)}`,
    scimToken,
  );
  expect(filterRes.status).toBe(200);
  expect(filterRes.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");
  expect((filterRes.body.totalResults ?? 0) >= 1).toBe(true);
  expect((filterRes.body.Resources ?? []).some((u) => u.id === userId)).toBe(true);

  const startsWithRes = await scimRequest<ScimListResponse<ScimUser>>(
    base,
    `/Users?filter=${encodeURIComponent(`userName sw "${runId}"`)}`,
    scimToken,
  );
  expect(startsWithRes.status).toBe(200);
  expect((startsWithRes.body.Resources ?? []).some((u) => u.id === userId)).toBe(true);

  const presenceRes = await scimRequest<ScimListResponse<ScimUser>>(
    base,
    `/Users?filter=${encodeURIComponent("emails.value pr")}`,
    scimToken,
  );
  expect(presenceRes.status).toBe(200);
  expect((presenceRes.body.Resources ?? []).some((u) => u.id === userId)).toBe(true);

  const patchRes = await scimRequest<ScimUser | Record<string, never>>(
    base,
    `/Users/${userId}`,
    scimToken,
    {
      method: "PATCH",
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    },
  );
  if (![200, 204].includes(patchRes.status)) {
    throw new Error(`SCIM PATCH failed: ${patchRes.status} ${JSON.stringify(patchRes.body)}`);
  }
  expect([200, 204]).toContain(patchRes.status);

  const deactivatedGet = await scimRequest<ScimUser>(base, `/Users/${userId}`, scimToken);
  expect(deactivatedGet.status).toBe(200);
  expect(deactivatedGet.body.active).toBe(false);
  expect(deactivatedGet.body.meta?.location).toBe(`${base}/Users/${userId}`);

  const putRes = await scimRequest<ScimUser>(base, `/Users/${userId}`, scimToken, {
    method: "PUT",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId,
      userName: userEmail,
      name: { givenName: "Updated", familyName: "Test" },
      emails: [{ value: userEmail, primary: true }],
      active: true,
    },
  });
  expect(putRes.status).toBe(200);
  expect(putRes.body.active).toBe(true);
  expect(putRes.body.meta?.resourceType).toBe("User");
  expect(putRes.body.meta?.location).toBe(`${base}/Users/${userId}`);
  expect(putRes.headers.get("location")).toBe(`${base}/Users/${userId}`);

  const pageRes = await scimRequest<ScimListResponse<ScimUser>>(
    base,
    "/Users?startIndex=1&count=10",
    scimToken,
  );
  expect(pageRes.status).toBe(200);
  expect(pageRes.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");
  expect(typeof pageRes.body.startIndex).toBe("number");
  expect(typeof pageRes.body.itemsPerPage).toBe("number");
  expect(typeof pageRes.body.totalResults).toBe("number");

  const secondUserRes = await scimRequest<ScimUser>(base, "/Users", scimToken, {
    method: "POST",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId: `ext-2-${runId}`,
      userName: `${runId}-2@example.com`,
      emails: [{ value: `${runId}-2@example.com`, primary: true }],
      active: true,
    },
  });
  expect(secondUserRes.status).toBe(201);
  const secondUserId = secondUserRes.body.id!;
  expect(secondUserId).toBeTruthy();

  const noExternalIdRes = await scimRequest<ScimUser>(base, "/Users", scimToken, {
    method: "POST",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: `${runId}-3@example.com`,
      emails: [{ value: `${runId}-3@example.com`, primary: true }],
      active: true,
    },
  });
  expect(noExternalIdRes.status).toBe(201);
  const noExternalIdUserId = noExternalIdRes.body.id!;
  expect(noExternalIdUserId).toBeTruthy();
  expect(noExternalIdRes.body.externalId).toBeUndefined();

  const groupExternalId = `group-${runId}`;
  const groupRes = await scimRequest<ScimGroup>(base, "/Groups", scimToken, {
    method: "POST",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      externalId: groupExternalId,
      displayName: `Group ${runId}`,
      members: [{ value: userId }],
    },
  });
  expect(groupRes.status).toBe(201);
  const scimGroupId = groupRes.body.id!;
  expect(scimGroupId).toBeTruthy();
  expect(groupRes.body.meta?.resourceType).toBe("Group");
  expect(groupRes.body.meta?.location).toBe(`${base}/Groups/${scimGroupId}`);
  expect(groupRes.headers.get("location")).toBe(`${base}/Groups/${scimGroupId}`);
  expect(groupRes.body.members?.map((member) => member.value)).toEqual([userId]);

  const groupRetryRes = await scimRequest<ScimGroup>(base, "/Groups", scimToken, {
    method: "POST",
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      externalId: groupExternalId,
      displayName: `Group ${runId} Retry`,
      members: [{ value: secondUserId }],
    },
  });
  expect(groupRetryRes.status).toBe(200);
  expect(groupRetryRes.body.id).toBe(scimGroupId);
  expect(groupRetryRes.body.members?.map((member) => member.value)).toEqual([userId]);

  const groupGetRes = await scimRequest<ScimGroup>(base, `/Groups/${scimGroupId}`, scimToken);
  expect(groupGetRes.status).toBe(200);
  expect(groupGetRes.body.meta?.resourceType).toBe("Group");
  expect(groupGetRes.body.meta?.location).toBe(`${base}/Groups/${scimGroupId}`);
  expect(groupGetRes.headers.get("location")).toBe(`${base}/Groups/${scimGroupId}`);
  expect(groupGetRes.body.members?.map((member) => member.value)).toEqual([userId]);

  const groupAddRes = await scimRequest<ScimGroup>(base, `/Groups/${scimGroupId}`, scimToken, {
    method: "PATCH",
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "add", path: "members", value: [{ value: secondUserId }] }],
    },
  });
  expect(groupAddRes.status).toBe(200);
  expect(groupAddRes.body.members?.map((member) => member.value).sort()).toEqual(
    [secondUserId, userId].sort(),
  );

  const groupRemoveRes = await scimRequest<ScimGroup>(base, `/Groups/${scimGroupId}`, scimToken, {
    method: "PATCH",
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "remove", path: `members[value eq "${userId}"]` }],
    },
  });
  expect(groupRemoveRes.status).toBe(200);
  expect(groupRemoveRes.body.members?.map((member) => member.value)).toEqual([secondUserId]);

  const renamedGroup = `Renamed ${runId}`;
  const groupReplaceRes = await scimRequest<ScimGroup>(base, `/Groups/${scimGroupId}`, scimToken, {
    method: "PATCH",
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        { op: "replace", path: "displayName", value: renamedGroup },
        { op: "replace", path: "members", value: [{ value: userId }] },
      ],
    },
  });
  expect(groupReplaceRes.status).toBe(200);
  expect(groupReplaceRes.body.displayName).toBe(renamedGroup);
  expect(groupReplaceRes.body.members?.map((member) => member.value)).toEqual([userId]);

  const groupListRes = await scimRequest<ScimListResponse<ScimGroup>>(base, "/Groups", scimToken);
  expect(groupListRes.status).toBe(200);
  expect(groupListRes.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");
  expect((groupListRes.body.Resources ?? []).some((group) => group.id === scimGroupId)).toBe(true);

  const memberFilterRes = await scimRequest<ScimListResponse<ScimGroup>>(
    base,
    `/Groups?filter=${encodeURIComponent(`members.value eq "${userId}"`)}`,
    scimToken,
  );
  expect(memberFilterRes.status).toBe(200);
  expect((memberFilterRes.body.Resources ?? []).some((group) => group.id === scimGroupId)).toBe(
    true,
  );

  const authFailRes = await scimRequest<unknown>(base, "/Users", "invalid-token");
  expect(authFailRes.status).toBe(401);

  const deleteRes = await scimRequest<unknown>(base, `/Users/${userId}`, scimToken, {
    method: "DELETE",
  });
  expect(deleteRes.status).toBe(204);

  const afterDelete = await scimRequest<unknown>(base, `/Users/${userId}`, scimToken);
  expect([404, 410]).toContain(afterDelete.status);

  const auditEvents = (
    await groupAuditListRpc(convexClient, convexUserToken, {
      connectionId,
      paginationOpts: { numItems: 500, cursor: null },
    })
  ).page as AuthEventProjection[];
  expect(
    auditEvents.some(
      (event) => event.kind === "connection.scim.set" && event.outcome === "success",
    ),
  ).toBe(true);
  expect(
    auditEvents.some(
      (event) => event.kind === "connection.scim.user.provisioned" && event.subjectId === userId,
    ),
  ).toBe(true);
  expect(
    auditEvents.some(
      (event) => event.kind === "connection.scim.user.updated" && event.subjectId === userId,
    ),
  ).toBe(true);
  expect(
    auditEvents.some(
      (event) => event.kind === "connection.scim.user.deactivated" && event.subjectId === userId,
    ),
  ).toBe(true);
  expect(
    auditEvents.some(
      (event) =>
        event.kind === "connection.scim.group.provisioned" && event.subjectId === scimGroupId,
    ),
  ).toBe(true);
  expect(
    auditEvents.some(
      (event) => event.kind === "connection.scim.group.updated" && event.subjectId === scimGroupId,
    ),
  ).toBe(true);

  const webhookEndpoints = (await groupWebhookEndpointListRpc(
    convexClient,
    convexUserToken,
    connectionId,
  )) as GroupWebhookEndpoint[];
  expect(
    webhookEndpoints.some((endpoint) => endpoint.url === `https://example.com/webhooks/${runId}`),
  ).toBe(true);
  expect(webhookEndpoints.every((endpoint) => endpoint.secretHash === undefined)).toBe(true);

  const webhookDeliveries = (
    await groupWebhookDeliveryListRpc(convexClient, convexUserToken, {
      connectionId,
      paginationOpts: { numItems: 50, cursor: null },
    })
  ).page as GroupWebhookDelivery[];
  expect(
    webhookDeliveries.some(
      (delivery) => delivery.kind === "connection.scim.set" && delivery.eventId,
    ),
  ).toBe(true);
  expect(
    webhookDeliveries.some(
      (delivery) => delivery.kind === "connection.scim.user.provisioned" && delivery.eventId,
    ),
  ).toBe(true);
  expect(
    webhookDeliveries.some(
      (delivery) => delivery.kind === "connection.scim.group.updated" && delivery.eventId,
    ),
  ).toBe(true);
}, 60_000);
