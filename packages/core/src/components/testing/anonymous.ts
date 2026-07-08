import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../anonymous/schema.js";
const modules = import.meta.glob("../anonymous/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerAnonymousProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authAnonymous",
) {
  t.registerComponent(name, schema, modules);
}
export default { registerAnonymousProvider, schema, modules };
