/// <reference types="vite/client" />
// This helper ships as TypeScript, not as part of the compiled build: the
// `import.meta.glob` below is a Vite macro that only works if the consumer's
// bundler transforms this file. Vitest externalizes plain `.js` under
// `node_modules` and would leave the macro untransformed, but it can't
// externalize `.ts`, so shipping source is what makes this work at all.
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
