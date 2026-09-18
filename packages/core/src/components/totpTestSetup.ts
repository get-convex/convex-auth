import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, vi } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "./totp/_generated/api.ts";
import schema from "./totp/schema.ts";
import { DEFAULT_PERIOD, totp } from "./totp/totp.ts";

export const modules = import.meta.glob("./totp/**/*.ts");

export const PERIOD_MS = DEFAULT_PERIOD * 1000;
// A moment in the middle of a time step, so that a few milliseconds of test
// time never cross a step boundary.
export const START = 1_700_000_015_000;
export const ENROLLMENT = {
  issuerDisplayName: "Acme",
  accountDisplayName: "alice@example.com",
};

/**
 * Make a test instance of the component. The component mounts the rate
 * limiter, so register it with the test instance too: the throttle of
 * `verifyCode` needs a backing component.
 */
export function setup(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

/**
 * Let the tests of the calling file control the clock: the codes depend on
 * the time, and the rate limiter refills with it. Only `Date` is faked,
 * because convex-test uses the real timers.
 */
export function controlClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** The code an authenticator app shows for the secret, at the given time. */
export function codeFor(
  secret: string,
  atMs: number = Date.now(),
): Promise<string> {
  return totp({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, atMs);
}

/**
 * Enroll a user, and move the clock one step forward: the code that confirms
 * the secret cannot be used again, thus a test that verifies a code right
 * after the enrollment needs the code of a later step.
 */
export async function enroll(
  t: TestConvex<typeof schema>,
  userId: string = "alice",
): Promise<{ secret: string; backupCodes: string[] }> {
  const { secret } = await t.mutation(api.enrollment.createTotp, {
    userId,
    ...ENROLLMENT,
  });
  const result = await t.mutation(api.enrollment.confirmTotp, {
    userId,
    code: await codeFor(secret),
  });
  if (!result.success) {
    throw new Error(`Enrollment failed: ${JSON.stringify(result)}`);
  }
  advance(PERIOD_MS);
  return { secret, backupCodes: result.backupCodes };
}
