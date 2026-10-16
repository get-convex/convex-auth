import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api.ts";
import type { Id } from "./_generated/dataModel.ts";
import schema from "./schema.ts";
import * as testApp from "./testApp.fixture.ts";
import { sha256Hex } from "../lib/crypto.ts";

/**
 * Sessions written by 2.0.0-alpha.2 (the current refresh token on the session,
 * rotated-away hashes in `spentRefreshTokens`) keep working after the upgrade:
 * migrated on their next use, or in batches by `migrateLegacySessions`.
 */
const modules = {
  ...import.meta.glob(["./**/*.ts", "!./**/*.fixture.ts"]),
  "./testApp.ts": async () => testApp,
};

const ISSUER = "https://example.convex.site";

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  process.env.AUTH_PRIVATE_KEY = btoa(await exportPKCS8(privateKey));
  process.env.AUTH_JWKS = JSON.stringify({
    keys: [
      {
        ...(await exportJWK(publicKey)),
        kid: "test-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

/**
 * An alpha.2 session as alpha.2 left it after `rotations` refreshes: the
 * current token on the session, and one rotated-away hash per refresh.
 * Returns the raw tokens, oldest first; the last one is the current token.
 */
async function legacySession(
  t: T,
  opts: { rotations: number; expiresAt?: number; userId?: string },
): Promise<{ sessionId: Id<"sessions">; tokens: string[] }> {
  const userId = opts.userId ?? "user-1";
  const tokens = Array.from(
    { length: opts.rotations + 1 },
    (_, i) => `${userId}-token-${i}`,
  );
  const sessionId = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      provider: "password",
      providerAccountId: userId,
      userId,
    });
    return await ctx.db.insert("sessions", {
      userId,
      accountId,
      lastRefreshedAt: Date.now(),
      refreshTokenHash: await sha256Hex(tokens[tokens.length - 1]),
      refreshTokenExpiresAt: opts.expiresAt ?? Date.now() + 86_400_000,
    });
  });
  // alpha.2 wrote each rotated-away hash at the refresh that replaced it.
  for (const token of tokens.slice(0, -1)) {
    vi.advanceTimersByTime(60_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("spentRefreshTokens", {
        hash: await sha256Hex(token),
        sessionId,
      });
    });
  }
  return { sessionId, tokens };
}

const refresh = (t: T, refreshToken: string) =>
  t.mutation(api.public.refresh, { refreshToken, issuer: ISSUER });

describe("2.0.0-alpha.2 sessions", () => {
  test("the current token refreshes, and the session continues as a 2.0 one", async () => {
    const t = setup();
    const { sessionId, tokens } = await legacySession(t, { rotations: 2 });
    const r = await refresh(t, tokens[2]);
    expect(r.kind).toBe("rotated");
    if (r.kind !== "rotated") return;
    expect(r.tokens.userId).toBe("user-1");

    const state = await t.run(async (ctx) => ({
      session: await ctx.db.get("sessions", sessionId),
      legacy: await ctx.db.query("spentRefreshTokens").collect(),
      tokens: await ctx.db.query("refreshTokens").collect(),
    }));
    expect(state.session?.refreshTokenHash).toBeUndefined();
    expect(state.session?.refreshTokenExpiresAt).toBeUndefined();
    expect(state.legacy).toEqual([]);
    // tokens[2] was just redeemed, which spent tokens[1] (alpha.2's last rotation).
    const stateOf = async (raw: string) => {
      const hash = await sha256Hex(raw);
      return state.tokens.find((x) => x.hash === hash)?.state;
    };
    expect(await stateOf(tokens[0])).toBe("spent");
    expect(await stateOf(tokens[1])).toBe("spent");
    expect(await stateOf(tokens[2])).toBe("redeemed");

    // And the token it got back refreshes like any other.
    expect((await refresh(t, r.tokens.refreshToken)).kind).toBe("rotated");
  });

  test("a client whose last alpha.2 refresh response was lost can retry with the token it holds", async () => {
    const t = setup();
    const { tokens } = await legacySession(t, { rotations: 2 });
    // tokens[1] is the newest rotated-away token: alpha.2's grace case.
    expect((await refresh(t, tokens[1])).kind).toBe("rotated");
  });

  test("an older rotated-away token still revokes the session", async () => {
    const t = setup();
    const { sessionId, tokens } = await legacySession(t, { rotations: 2 });
    expect((await refresh(t, tokens[0])).kind).toBe("noSession");
    expect(await t.run((ctx) => ctx.db.get("sessions", sessionId))).toBeNull();
    expect((await refresh(t, tokens[2])).kind).toBe("noSession");
  });

  test("a session never refreshed under alpha.2 refreshes", async () => {
    const t = setup();
    const { tokens } = await legacySession(t, { rotations: 0 });
    expect((await refresh(t, tokens[0])).kind).toBe("rotated");
  });

  test("an alpha.2 token signs out", async () => {
    const t = setup();
    const { sessionId, tokens } = await legacySession(t, { rotations: 1 });
    await t.mutation(api.public.signOut, { refreshToken: tokens[1] });
    expect(await t.run((ctx) => ctx.db.get("sessions", sessionId))).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.query("refreshTokens").collect()),
    ).toEqual([]);
  });

  test("an expired alpha.2 session reports no session", async () => {
    const t = setup();
    const { sessionId, tokens } = await legacySession(t, {
      rotations: 1,
      expiresAt: Date.now() - 1,
    });
    expect((await refresh(t, tokens[1])).kind).toBe("noSession");
    expect(await t.run((ctx) => ctx.db.get("sessions", sessionId))).toBeNull();
  });

  test("a rotated-away hash whose session is gone is cleared and grants nothing", async () => {
    const t = setup();
    const { sessionId, tokens } = await legacySession(t, { rotations: 1 });
    await t.run((ctx) => ctx.db.delete("sessions", sessionId));
    expect((await refresh(t, tokens[0])).kind).toBe("noSession");
    expect(
      await t.run((ctx) => ctx.db.query("spentRefreshTokens").collect()),
    ).toEqual([]);
  });
});

describe("migrateLegacySessions", () => {
  test("migrates every session, then clears orphaned hashes; old tokens keep working", async () => {
    const t = setup();
    const a = await legacySession(t, { rotations: 2, userId: "a" });
    const b = await legacySession(t, { rotations: 0, userId: "b" });
    const gone = await legacySession(t, { rotations: 1, userId: "gone" });
    await t.run((ctx) => ctx.db.delete("sessions", gone.sessionId));

    expect(await t.mutation(api.public.migrateLegacySessions, {})).toEqual({
      migrated: 2,
      orphansDeleted: 1,
      done: true,
    });
    expect(await t.mutation(api.public.migrateLegacySessions, {})).toEqual({
      migrated: 0,
      orphansDeleted: 0,
      done: true,
    });
    const sessions = await t.run((ctx) => ctx.db.query("sessions").collect());
    expect(sessions.every((s) => s.refreshTokenHash === undefined)).toBe(true);

    expect((await refresh(t, a.tokens[2])).kind).toBe("rotated");
    expect((await refresh(t, b.tokens[0])).kind).toBe("rotated");
  });
});
