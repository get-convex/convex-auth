import { afterEach, describe, expect, test, vi } from "vitest";
import { retryOnNetworkError } from "./retry.ts";

/** A fetch-level failure the way Chromium words it. */
function networkError() {
  return new TypeError("Failed to fetch");
}

/**
 * Fake timers plus a pinned `Math.random` so the backoff waits are exactly
 * 550ms and 2050ms (backoff + half the jitter).
 */
function useDeterministicTime() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
}

describe("retryOnNetworkError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("returns the first attempt's result without sleeping", async () => {
    useDeterministicTime();
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(retryOnNetworkError(fn)).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("retries network errors with backoff and succeeds on the last attempt", async () => {
    useDeterministicTime();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce("ok");
    const log = vi.fn();

    const promise = retryOnNetworkError(fn, log);
    await vi.advanceTimersByTimeAsync(550);
    await vi.advanceTimersByTimeAsync(2050);

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "network error, retry 1 in 550ms",
      "network error, retry 2 in 2050ms",
    ]);
  });

  test("rethrows a non-network error immediately", async () => {
    useDeterministicTime();
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    // No timers are advanced because a non-network error must not schedule
    // a retry.
    await expect(retryOnNetworkError(fn)).rejects.toThrow("boom");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("throws the last network error with no sleep after the final attempt", async () => {
    useDeterministicTime();
    const fn = vi.fn().mockRejectedValue(networkError());

    const promise = retryOnNetworkError(fn);
    const expectation = expect(promise).rejects.toThrow("Failed to fetch");
    // Two backoffs. The rejection settles right after the second without a
    // trailing sleep (the test would otherwise hang on real pending timers).
    await vi.advanceTimersByTimeAsync(550);
    await vi.advanceTimersByTimeAsync(2050);

    await expectation;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
