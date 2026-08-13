import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../../oauth/component/schema";
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
