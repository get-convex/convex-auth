/**
 * Regression: device-flow `verify` must not orphan a Session nor silently
 * replace the approving user's own session (concurrency cluster, item 2).
 *
 * `verify` now mints the device's session directly and binds it with the
 * `authorize` compare-and-set, instead of routing through `callSignIn` — which
 * would have replaced the caller's current session *before* the CAS decided the
 * winner, leaving a losing racer's session orphaned and logging the approver
 * out. After the fix the approver keeps their session, the device gets a fresh
 * distinct one, and a lost CAS rolls its optimistically-minted session back.
 *
 * The lost-CAS branch itself is a single-transaction compare-and-set covered by
 * the component-level tests in `device.test.ts` (`authorize` returns
 * `transitioned: false` on the second call); it cannot be interleaved mid-action
 * under `convexTest`, so this suite pins the observable no-replace / no-orphan
 * outcome of a successful verify.
 */

import { api, components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { decodeJwt } from "jose";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";
import { expectSignInSession, TEST_PASSWORD } from "./helpers";

test("device verify preserves the approver session and mints a distinct device session", async () => {
  const t = convexTest(schema);

  const approverTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: "device-verify-race@example.com",
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const claims = decodeJwt(approverTokens!.token);
  const approverUserId = claims.sub as string;
  const approverSessionId = claims.sid as string;
  const asUser = t.withIdentity({ subject: approverUserId, sid: approverSessionId as never });

  // The device (unauthenticated) starts the flow...
  const created = await t.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "create" },
  });
  const { deviceCode, userCode } =
    created.kind === "deviceCode" ? created.deviceCode : { deviceCode: "", userCode: "" };
  expect(userCode).not.toEqual("");

  // ...and the signed-in user approves it.
  const verified = await asUser.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "verify", userCode },
  });
  expect(verified.kind).toBe("signedIn");

  // The approver's own session must still exist — verify no longer replaces it.
  const approverSession = await t.run((ctx) =>
    ctx.runQuery(components.auth.session.get, { id: approverSessionId as never }),
  );
  expect(approverSession).not.toBeNull();

  // The device was bound to its OWN session: the approver's session is still
  // present and at least one other (device) session exists alongside it.
  const sessions = (await t.run((ctx) =>
    ctx.runQuery(components.auth.session.list, { userId: approverUserId as never }),
  )) as Array<{ _id: string }>;
  expect(sessions.some((session) => session._id === approverSessionId)).toBe(true);
  expect(sessions.some((session) => session._id !== approverSessionId)).toBe(true);

  // The device can still complete poll and receive its own tokens.
  const polled = await t.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "poll", deviceCode },
  });
  expect(expectSignInSession(polled)).not.toBeNull();
});
