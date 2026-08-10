import { vi } from "vitest";
import type { AuthRunner } from "./client";

/**
 * A stub {@link AuthRunner} for tests, with the mock standing in for the Convex
 * call.
 *
 * Provider hooks run their sign-in function through the runner rather than
 * calling `useMutation`/`useAction`, so tests substitute a runner instead of
 * mocking `convex/react`.
 */
export function stubRunner(): {
  runner: AuthRunner;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn();
  const runner = {
    mutation: (_fn: unknown, args: unknown) => run(args),
    action: (_fn: unknown, args: unknown) => run(args),
  } as unknown as AuthRunner;
  return { runner, run };
}
