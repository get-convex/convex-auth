import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../username/schema";
const modules = import.meta.glob("../username/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerUsername(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authUsername",
) {
  t.registerComponent(name, schema, modules);
}
export default { registerUsername, schema, modules };
