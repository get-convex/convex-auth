import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../passkey/schema";
const modules = import.meta.glob("../passkey/**/*.ts");

/**
 * Register the passkey provider component with a `convex-test` instance.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerPasskeyProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authPasskey",
) {
  t.registerComponent(name, schema, modules);
}
export default { registerPasskeyProvider, schema, modules };
