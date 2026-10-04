/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import schema from "../passkey/schema.js";
const modules = import.meta.glob("../passkey/**/*.ts");

/**
 * Register the passkey provider with a test Convex instance.
 * Its cleanup worker is mounted under `<name>/batchWorker`.
 *
 * @param t - The test Convex instance, e.g. from calling `convexTest`.
 * @param name - The component's name in convex.config.ts.
 */
export function registerPasskeyProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authPasskey",
) {
  t.registerComponent(name, schema, modules);
  registerBatchWorker(t, `${name}/batchWorker`);
}
export default { registerPasskeyProvider, schema, modules };
