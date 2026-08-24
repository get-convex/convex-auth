/// <reference types="vite/client" />
// This helper ships as TypeScript, not as part of the compiled build: the
// `import.meta.glob` below is a Vite macro that only works if the consumer's
// bundler transforms this file. Vitest externalizes plain `.js` under
// `node_modules` and would leave the macro untransformed, but it can't
// externalize `.ts`, so shipping source is what makes this work at all.
// The schema import below uses the extension of the file on disk. The
// TypeScript compiler of the consumer reads this file, thus the consumer must
// set `allowImportingTsExtensions`. If it is not set, TypeScript gives the
// error TS5097.
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../../oauth/component/schema.ts";
const modules = import.meta.glob("../../oauth/component/**/*.ts");

/**
 * Register the OAuth component with a `convex-test` instance.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The mount name of this component instance, as registered in
 *   convex.config.ts (e.g. `"oauthGoogle"` - the component mounts once per
 *   provider). Defaults to `"oauth"`.
 */
export function registerOauth(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name = "oauth",
) {
  t.registerComponent(name, schema, modules);
}
export default { registerOauth, schema, modules };
