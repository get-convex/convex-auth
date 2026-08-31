import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerPasswordProvider } from "@convex-dev/auth/providers/testing/password";
import { registerUsername } from "@convex-dev/auth/providers/testing/username";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid

async function setup() {
  // The core signs JWTs from these env vars (see core/public.ts). Mint a real
  // RS256 key pair for each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);

  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(pkcs8));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  registerUsername(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type T = Awaited<ReturnType<typeof setup>>;

const signUp = (t: T, username: string, password: string) =>
  t.mutation(api.auth.signUpWithPassword, { username, password });

const signIn = (t: T, username: string, password: string) =>
  t.mutation(api.auth.signInWithPassword, { username, password });

const continueSignIn = (t: T, attemptToken: string) =>
  t.mutation(api.auth.continueSignInWithPassword, { attemptToken });

// The math factor's own endpoints: the client fetches the challenge and
// submits the answer here, out-of-band from the sign-in flow.
const getMathChallenge = (t: T, attemptToken: string) =>
  t.mutation(api.auth.getMathChallenge, { attemptToken });

const verifyMathAnswer = (t: T, attemptToken: string, answer: number) =>
  t.mutation(api.auth.verifyMathAnswer, { attemptToken, answer });

type AnyResult =
  | Awaited<ReturnType<typeof signUp>>
  | Awaited<ReturnType<typeof signIn>>
  | Awaited<ReturnType<typeof continueSignIn>>;

/** Narrow a result to its incomplete arm, failing the test on a mismatch. */
function expectIncomplete(result: AnyResult) {
  if (result.status !== "incomplete") {
    throw new Error(`expected an incomplete result: ${JSON.stringify(result)}`);
  }
  return result;
}

/** Narrow a result to its success arm, failing the test on a mismatch. */
function expectComplete(result: AnyResult) {
  if (result.status !== "complete") {
    throw new Error(`expected a complete result: ${JSON.stringify(result)}`);
  }
  return result.tokens;
}

/** Narrow a status-discriminated result, failing the test on a mismatch. */
function expectStatus<R extends { status: string }, S extends R["status"]>(
  result: R,
  status: S,
): Extract<R, { status: S }> {
  expect(result.status).toBe(status);
  return result as Extract<R, { status: S }>;
}

/** Fetch the attempt's current math challenge and compute the answer. */
async function solveMath(t: T, attemptToken: string): Promise<number> {
  const challenge = expectStatus(
    await getMathChallenge(t, attemptToken),
    "challenge",
  );
  const [a, b] = challenge.question.split(" + ").map(Number);
  return a + b;
}

/** Drive the math factor to verified for an attempt. */
async function passMathFactor(t: T, attemptToken: string): Promise<void> {
  const answer = await solveMath(t, attemptToken);
  expect(await verifyMathAnswer(t, attemptToken, answer)).toEqual({
    status: "verified",
  });
}

const completeTokens = {
  accessToken: expect.any(String),
  accessTokenExpiresAt: expect.any(Number),
  refreshToken: expect.any(String),
  refreshTokenExpiresAt: expect.any(Number),
  userId: expect.any(String),
};

/** Sign up completely and return the minted userId. */
async function signUpComplete(t: T, username: string): Promise<string> {
  const gated = expectIncomplete(await signUp(t, username, PASSWORD));
  await passMathFactor(t, gated.attemptToken);
  return expectComplete(await continueSignIn(t, gated.attemptToken)).userId;
}

describe("sign-up gated by the math factor", () => {
  test("sign-up parks on the factor, then completes", async () => {
    const t = await setup();
    const incomplete = expectIncomplete(await signUp(t, "alice", PASSWORD));
    // The requirement is bare: the challenge comes from the factor's own
    // endpoint, not the requirement payload.
    expect(incomplete.requirements).toEqual([
      { kind: "mathFactor:problem", data: {} },
    ]);
    // The pending state is server-side: a bearer attempt token came back,
    // and the app's userId did not (it's stripped from client results).
    expect(typeof incomplete.attemptToken).toBe("string");
    expect(incomplete.expiresAt).toBeGreaterThan(Date.now());
    expect(incomplete).not.toHaveProperty("tokens");
    expect(incomplete).not.toHaveProperty("userId");

    await passMathFactor(t, incomplete.attemptToken);
    const done = await continueSignIn(t, incomplete.attemptToken);
    expect(done).toEqual({ status: "complete", tokens: completeTokens });
  });

  test("continuing before the factor is verified stays incomplete", async () => {
    const t = await setup();
    const incomplete = expectIncomplete(await signUp(t, "alice", PASSWORD));

    const still = expectIncomplete(
      await continueSignIn(t, incomplete.attemptToken),
    );
    expect(still.requirements).toEqual([
      { kind: "mathFactor:problem", data: {} },
    ]);
    // Continuing keeps the same attempt (token and expiry are unchanged).
    expect(still.attemptToken).toBe(incomplete.attemptToken);
    expect(still.expiresAt).toBe(incomplete.expiresAt);

    await passMathFactor(t, incomplete.attemptToken);
    expectComplete(await continueSignIn(t, incomplete.attemptToken));
  });

  test("a wrong answer is metered and the same challenge stands", async () => {
    const t = await setup();
    const incomplete = expectIncomplete(await signUp(t, "alice", PASSWORD));
    const token = incomplete.attemptToken;

    const question = expectStatus(
      await getMathChallenge(t, token),
      "challenge",
    ).question;
    expect(await verifyMathAnswer(t, token, -1)).toEqual({
      status: "incorrect",
    });
    // The challenge wasn't consumed or reissued by the failure.
    expect(await getMathChallenge(t, token)).toEqual({
      status: "challenge",
      question,
    });

    await passMathFactor(t, token);
    expectComplete(await continueSignIn(t, token));
  });

  test("credentials are stored even while the sign-up is incomplete", async () => {
    const t = await setup();
    // Reach the math gate, then abandon the sign-up. The user, account,
    // username and password all exist — only the session is withheld.
    expectIncomplete(await signUp(t, "alice", PASSWORD));

    // Self-healing: signing *in* with the right password re-runs the
    // evaluator (a fresh attempt) and re-prompts; a wrong password is
    // rejected; re-signing up reports the taken username.
    expectIncomplete(await signIn(t, "alice", PASSWORD));
    expect(await signIn(t, "alice", "wrong horse battery staple")).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(await signUp(t, "alice", PASSWORD)).toEqual({
      status: "error",
      userError: { error: "USERNAME_TAKEN" },
    });
  });
});

describe("sign-in requirements", () => {
  test("every sign-in re-runs the math gate and resolves the same user", async () => {
    const t = await setup();
    const userId = await signUpComplete(t, "alice");

    const attempt = expectIncomplete(await signIn(t, "alice", PASSWORD));
    expect(attempt.requirements).toEqual([
      { kind: "mathFactor:problem", data: {} },
    ]);
    await passMathFactor(t, attempt.attemptToken);
    const done = expectComplete(await continueSignIn(t, attempt.attemptToken));
    expect(done.userId).toBe(userId);
  });

  test("a fresh sign-in supersedes the pending attempt", async () => {
    const t = await setup();
    const userId = await signUpComplete(t, "alice");

    const first = expectIncomplete(await signIn(t, "alice", PASSWORD));
    const second = expectIncomplete(await signIn(t, "alice", PASSWORD));
    expect(second.attemptToken).not.toBe(first.attemptToken);

    // The superseded attempt is gone — its token opens nothing.
    expect(await getMathChallenge(t, first.attemptToken)).toEqual({
      status: "expired",
    });
    expect(await continueSignIn(t, first.attemptToken)).toEqual({
      status: "error",
      userError: { error: "ATTEMPT_EXPIRED" },
    });
    // The live one completes.
    await passMathFactor(t, second.attemptToken);
    const done = expectComplete(await continueSignIn(t, second.attemptToken));
    expect(done.userId).toBe(userId);
  });

  test("attempts expire", async () => {
    const t = await setup();
    await signUpComplete(t, "alice");

    const attempt = expectIncomplete(await signIn(t, "alice", PASSWORD));
    const answer = await solveMath(t, attempt.attemptToken);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000); // past the 10 min TTL

    expect(await verifyMathAnswer(t, attempt.attemptToken, answer)).toEqual({
      status: "expired",
    });
    expect(await continueSignIn(t, attempt.attemptToken)).toEqual({
      status: "error",
      userError: { error: "ATTEMPT_EXPIRED" },
    });
  });

  test("repeated failed verifications discard the attempt", async () => {
    const t = await setup();
    await signUpComplete(t, "alice");

    const attempt = expectIncomplete(await signIn(t, "alice", PASSWORD));
    const token = attempt.attemptToken;
    const answer = await solveMath(t, token);

    // Nine wrong answers fit under the continuation cap of ten...
    for (let i = 0; i < 9; i++) {
      expect(await verifyMathAnswer(t, token, -1)).toEqual({
        status: "incorrect",
      });
    }
    // ...the tenth exhausts it, and even the right answer is refused.
    expect(await verifyMathAnswer(t, token, -1)).toEqual({
      status: "expired",
    });
    expect(await verifyMathAnswer(t, token, answer)).toEqual({
      status: "expired",
    });
    expect(await continueSignIn(t, token)).toEqual({
      status: "error",
      userError: { error: "ATTEMPT_EXPIRED" },
    });
  });

  test("a fresh sign-in drops recorded facts and re-proves the factor", async () => {
    const t = await setup();
    await signUpComplete(t, "alice");

    // Verify the factor on the first attempt, but don't continue it.
    const first = expectIncomplete(await signIn(t, "alice", PASSWORD));
    await passMathFactor(t, first.attemptToken);

    // A fresh sign-in supersedes the attempt and starts with an empty facts
    // bag: the factor must be proven again.
    const fresh = expectIncomplete(await signIn(t, "alice", PASSWORD));
    expect(fresh.requirements.map((r) => r.kind)).toContain(
      "mathFactor:problem",
    );
    expectIncomplete(await continueSignIn(t, fresh.attemptToken));
  });

  test("an unknown attempt token reports ATTEMPT_EXPIRED", async () => {
    const t = await setup();
    expect(await continueSignIn(t, "no-such-token")).toEqual({
      status: "error",
      userError: { error: "ATTEMPT_EXPIRED" },
    });
  });
});

describe("input validation", () => {
  test("a wrong-typed answer is rejected at the factor endpoint", async () => {
    const t = await setup();
    const attempt = expectIncomplete(await signUp(t, "alice", PASSWORD));

    // A string answer is a malformed request (a bug or a hostile client),
    // not a wrong answer — it throws rather than counting as a guess.
    await expect(
      t.mutation(api.auth.verifyMathAnswer, {
        attemptToken: attempt.attemptToken,
        answer: "9" as unknown as number,
      }),
    ).rejects.toThrow(/Validator error: Expected `number`/);

    // The throw aborted that transaction: the attempt is untouched and the
    // flow still completes.
    await passMathFactor(t, attempt.attemptToken);
    expectComplete(await continueSignIn(t, attempt.attemptToken));
  });
});
