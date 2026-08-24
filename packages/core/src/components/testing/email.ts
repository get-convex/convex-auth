import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../email/schema.ts";
const modules = import.meta.glob("../email/**/*.ts");

/**
 * Register the email component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerEmail(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authEmail",
) {
  t.registerComponent(name, schema, modules);
}
export default { registerEmail, schema, modules };
