/**
 * Device Authorization Grant (RFC 8628) tests.
 *
 * Focus: the atomic state transitions that make verify/poll idempotent
 * (audit finding R3). The `authorize` compare-and-set and the `accept`
 * mutation each run in a single component transaction, so a retried or
 * concurrent verify/poll cannot mint a second (orphaned) session.
 */

import { api, components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { decodeJwt } from "jose";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";
import { expectSignInSession, TEST_EMAIL, TEST_PASSWORD } from "./helpers";

/** Hash a device code the way the server does before storing/looking it up. */
async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Create a user + a pending device code, returning ids and the code hash. */
async function seedPendingDevice(t: ReturnType<typeof convexTest>, email: string) {
  return await t.run(async (ctx) => {
    const userId = (await ctx.runMutation(components.auth.user.create, {
      data: { email },
    })) as string;
    const deviceCodeHash = await sha256Hex("device-code-" + email);
    const deviceId = await ctx.runMutation(components.auth.factor.device.create, {
      deviceCodeHash,
      userCode: "ABCD-1234",
      expiresAt: Date.now() + 60_000,
      interval: 5,
      status: "pending",
    });
    return { userId, deviceId, deviceCodeHash };
  });
}

test("device authorize is a pending->authorized compare-and-set", async () => {
  const t = convexTest(schema);
  const { userId, deviceId } = await seedPendingDevice(t, "device-cas@example.com");

  const first = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.authorize, {
      id: deviceId,
      userId: userId as never,
      now: Date.now(),
      sessionExpirationTime: Date.now() + 60_000,
    }),
  );
  expect(first.transitioned).toBe(true);
  expect(first.sessionId).toBeDefined();

  // A concurrent / retried verify must NOT clobber the already-authorized code.
  const second = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.authorize, {
      id: deviceId,
      userId: userId as never,
      now: Date.now(),
      sessionExpirationTime: Date.now() + 60_000,
    }),
  );
  expect(second).toEqual({ transitioned: false });

  const sessions = await t.run((ctx) =>
    ctx.runQuery(components.auth.session.list, { userId: userId as never }),
  );
  expect(sessions).toHaveLength(1);
});

test("device accept returns the binding exactly once", async () => {
  const t = convexTest(schema);
  const { userId, deviceId, deviceCodeHash } = await seedPendingDevice(
    t,
    "device-accept@example.com",
  );

  const authorized = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.authorize, {
      id: deviceId,
      userId: userId as never,
      now: Date.now(),
      sessionExpirationTime: Date.now() + 60_000,
    }),
  );
  const sessionId = authorized.sessionId!;

  const first = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.accept, {
      deviceCodeHash,
      now: Date.now(),
    }),
  );
  expect(first).toEqual({ userId, sessionId });

  // Second accept (retry / concurrent poll) finds nothing — no second session.
  const second = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.accept, {
      deviceCodeHash,
      now: Date.now(),
    }),
  );
  expect(second).toBeNull();
});

test("device accept rejects a still-pending code", async () => {
  const t = convexTest(schema);
  const { deviceCodeHash } = await seedPendingDevice(t, "device-pending@example.com");

  const result = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.accept, {
      deviceCodeHash,
      now: Date.now(),
    }),
  );
  expect(result).toBeNull();
});

test("device accept rejects an expired authorized code", async () => {
  const t = convexTest(schema);
  const { userId, deviceId, deviceCodeHash } = await seedPendingDevice(
    t,
    "device-expired@example.com",
  );
  await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.authorize, {
      id: deviceId,
      userId: userId as never,
      now: Date.now(),
      sessionExpirationTime: Date.now() + 60_000,
    }),
  );

  const result = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.device.accept, {
      deviceCodeHash,
      now: Date.now() + 120_000,
    }),
  );
  expect(result).toBeNull();
});

test("device flow: create, verify, poll signs the device in", async () => {
  const t = convexTest(schema);

  const signInTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email: TEST_EMAIL, password: TEST_PASSWORD, flow: "signUp" },
    }),
  );
  const claims = decodeJwt(signInTokens!.token);
  const asUser = t.withIdentity({ subject: claims.sub, sid: claims.sid as never });

  const created = await t.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "create" },
  });
  expect(created.kind).toBe("deviceCode");
  const { deviceCode, userCode } =
    created.kind === "deviceCode" ? created.deviceCode : { deviceCode: "", userCode: "" };
  expect(deviceCode).not.toEqual("");

  const verified = await asUser.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "verify", userCode },
  });
  expect(verified.kind).toBe("signedIn");

  const polled = await t.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "poll", deviceCode },
  });
  const pollTokens = expectSignInSession(polled);
  expect(pollTokens).not.toBeNull();
  expect(pollTokens!.token).toBeTruthy();

  // Polling again after consumption yields no second session (idempotent).
  await expect(
    t.action(api.auth.signIn, {
      provider: "device",
      params: { flow: "poll", deviceCode },
    }),
  ).rejects.toThrow();
});
