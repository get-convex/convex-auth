/// <reference types="vite/client" />
// This helper ships as TypeScript, not as part of the compiled build: the
// `import.meta.glob` below is a Vite macro that only works if the consumer's
// bundler transforms this file. Vitest externalizes plain `.js` under
// `node_modules` and would leave the macro untransformed, but it can't
// externalize `.ts`, so shipping source is what makes this work at all.
// The schema import below keeps the `.js` extension. The TypeScript compiler
// of the consumer reads this file. A `.ts` extension in an import is an error
// (TS5097) unless the consumer sets `allowImportingTsExtensions`.
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../core/schema.js";
const modules = import.meta.glob("../core/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerCore(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "auth",
) {
  t.registerComponent(name, schema, modules);
}
export default { registerCore, schema, modules };
