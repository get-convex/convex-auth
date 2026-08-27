import { convexTest, type TestConvex } from "convex-test";
import { expect, vi } from "vitest";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import schema from "./passkey/schema.ts";

export const modules = import.meta.glob("./passkey/**/*.ts");

/**
 * Make a test instance of the component. The component mounts the batch
 * worker (the ceremony mutations ping the cleanup loop), so register it
 * with the test instance too.
 */
export function setup(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  registerBatchWorker(t);
  return t;
}

/** Assert that two byte buffers hold the same bytes. */
export function expectSameBytes(
  a: ArrayBuffer | Uint8Array,
  b: ArrayBuffer | Uint8Array,
): void {
  expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
}

/**
 * Assert that a ceremony call rejects a client that does not respect the
 * WebAuthn protocol: the client gets `PROTOCOL_ERROR` and nothing else, and
 * the backend logs carry `detail`.
 */
export async function expectProtocolError(
  call: () => Promise<unknown>,
  detail: string,
): Promise<void> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(call()).resolves.toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(detail));
  } finally {
    warn.mockRestore();
  }
}
