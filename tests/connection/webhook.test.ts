import { components } from "@convex/_generated/api";
import { auth } from "@convex/auth";
import schema from "@convex/schema";
import { getLegacyWebhookEndpointPatch } from "@robelest/convex-auth/component/migrations";
import { getPublicWebhookEndpoint } from "@robelest/convex-auth/server/connection/webhook";
import { decryptSecret } from "@robelest/convex-auth/server/secret";
import { expect, test } from "vite-plus/test";

import { convexTest } from "../convex/setup";

test("legacy webhook migration disables hash-only endpoints and erases the hash", () => {
  expect(
    getLegacyWebhookEndpointPatch({
      status: "active",
      secretHash: "irreversible-sha256-hash",
    }),
  ).toEqual({ status: "disabled", secretHash: undefined });

  expect(
    getLegacyWebhookEndpointPatch({
      status: "disabled",
      secretHash: "irreversible-sha256-hash",
    }),
  ).toEqual({ secretHash: undefined });

  expect(
    getLegacyWebhookEndpointPatch({
      status: "active",
      secretCiphertext: "encrypted-secret",
    }),
  ).toBeUndefined();
});

test("public webhook projection strips all credential material and makes legacy rows inert", () => {
  const endpoint = getPublicWebhookEndpoint({
    _id: "endpoint-id",
    status: "active" as const,
    secretHash: "irreversible-sha256-hash",
    subscriptions: ["user.created", "removed.legacy.kind"],
  });

  expect(endpoint).toEqual({
    _id: "endpoint-id",
    status: "disabled",
    subscriptions: ["user.created"],
    hasSecret: false,
  });
  expect(endpoint).not.toHaveProperty("secretHash");
  expect(endpoint).not.toHaveProperty("secretCiphertext");
});

test("webhook endpoint update rotates the secret without exposing it", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Webhook Rotation",
      slug: "webhook-rotation",
      type: "organization",
    });
  });
  const connectionId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "webhook-rotation",
      name: "Webhook Rotation",
      status: "active",
      protocol: "oidc",
    });
  });
  await expect(
    t.run(async (ctx) => {
      return await auth.connection.webhook.endpoint.create(ctx, {
        connectionId,
        url: "https://example.com/webhooks/empty-secret",
        secret: "",
        subscriptions: ["user.created"],
      });
    }),
  ).rejects.toThrow("Webhook secret must not be empty.");
  const { endpointId } = await t.run(async (ctx) => {
    return await auth.connection.webhook.endpoint.create(ctx, {
      connectionId,
      url: "https://example.com/webhooks/rotate",
      secret: "old-secret",
      subscriptions: ["user.created"],
    });
  });

  const before = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.webhook.endpoint.get, {
      id: endpointId,
    });
  });
  await t.run(async (ctx) => {
    await auth.connection.webhook.endpoint.update(ctx, {
      id: endpointId,
      patch: {
        secret: "new-secret",
        status: "active",
        subscriptions: ["user.updated"],
      },
    });
  });
  const raw = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.webhook.endpoint.get, {
      id: endpointId,
    });
  });
  const publicEndpoint = await t.run(async (ctx) => {
    return await auth.connection.webhook.endpoint.get(ctx, { id: endpointId });
  });

  expect(raw?.secretCiphertext).not.toBe(before?.secretCiphertext);
  expect(await decryptSecret(raw!.secretCiphertext!)).toBe("new-secret");
  expect(raw).not.toHaveProperty("secretHash");
  expect(publicEndpoint).not.toHaveProperty("secretHash");
  expect(publicEndpoint).not.toHaveProperty("secretCiphertext");
  expect(publicEndpoint?.hasSecret).toBe(true);
  expect(publicEndpoint?.subscriptions).toEqual(["user.updated"]);
});
