import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../oauth/schema";
const modules = import.meta.glob("../oauth/**/*.ts");

/**
 * Register an OAuth provider component with a `convex-test` instance.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 *   OAuth mounts are per-IdP (e.g. `"oauthGoogle"`), so there is no default.
 */
export function registerOauthProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string,
) {
  t.registerComponent(name, schema, modules);
}
export default { registerOauthProvider, schema, modules };
