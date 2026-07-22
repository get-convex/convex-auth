/**
 * Regression tests for the atomic verifier consume (`component.token.pkce.consume`,
 * AuthVerifier atomic-consume — audit MINOR #6).
 *
 * The passkey and TOTP ceremonies run in actions, where reading the verifier and
 * deleting it were two separate transactions — so two concurrent requests with
 * the same verifier could both pass the read + signature check and each mint a
 * session (duplicate sign-in). `consume` folds read → validate → delete into ONE
 * mutation; these pin that mechanism: exactly one caller wins, a signature
 * mismatch does not burn the row, and an expired row is cleared but not consumed.
 */

import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

test("pkce.consume is single-use: the first caller gets the doc, the rest get null", async () => {
  const t = convexTest(schema);
  const id = (await t.run((ctx) =>
    ctx.runMutation(components.auth.token.pkce.create, { signature: "sig-abc" }),
  )) as string;

  const first = (await t.run((ctx) =>
    ctx.runMutation(components.auth.token.pkce.consume, { id, expectedSignature: "sig-abc" }),
  )) as { _id: string } | null;
  expect(first?._id).toBe(id);

  // A second consume of the same verifier sees the now-absent row → null. This is
  // the invariant that keeps a concurrent ceremony from minting a second session.
  const second = await t.run((ctx) =>
    ctx.runMutation(components.auth.token.pkce.consume, { id, expectedSignature: "sig-abc" }),
  );
  expect(second).toBeNull();
});

test("pkce.consume rejects a signature mismatch WITHOUT burning the verifier", async () => {
  const t = convexTest(schema);
  const id = (await t.run((ctx) =>
    ctx.runMutation(components.auth.token.pkce.create, { signature: "real-sig" }),
  )) as string;

  // A wrong expected signature (a bad guess) must not consume the pending row.
  const mismatch = await t.run((ctx) =>
    ctx.runMutation(components.auth.token.pkce.consume, { id, expectedSignature: "wrong-sig" }),
  );
  expect(mismatch).toBeNull();

  // The legitimate caller can still consume it.
  const ok = (await t.run((ctx) =>
    ctx.runMutation(components.auth.token.pkce.consume, { id, expectedSignature: "real-sig" }),
  )) as { _id: string } | null;
  expect(ok?._id).toBe(id);
});

test("pkce.consume treats an expired verifier as not consumed and clears it", async () => {
  const t = convexTest(schema);
  const id = (await t.run((ctx) =>
    ctx.runMutation(components.auth.token.pkce.create, {
      signature: "exp-sig",
      expirationTime: Date.now() - 1_000,
    }),
  )) as string;

  const expired = await t.run((ctx) => ctx.runMutation(components.auth.token.pkce.consume, { id }));
  expect(expired).toBeNull();

  // It is gone rather than lingering.
  const gone = await t.run((ctx) => ctx.runQuery(components.auth.token.pkce.get, { id }));
  expect(gone).toBeNull();
});
