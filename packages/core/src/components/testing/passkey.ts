/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import schema from "../passkey/schema.js";
const modules = import.meta.glob("../passkey/**/*.ts");

/** Register the passkey provider and its nested cleanup worker for tests. */
export function registerPasskeyProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authPasskey",
) {
  t.registerComponent(name, schema, modules);
  registerBatchWorker(t, `${name}/batchWorker`);
}
export default { registerPasskeyProvider, schema, modules };
