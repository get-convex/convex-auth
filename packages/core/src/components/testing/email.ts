import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "../email/schema.ts";
const modules = import.meta.glob("../email/**/*.ts");

/**
 * Register the email component with a `convex-test` instance.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerEmail(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authEmail",
) {
  t.registerComponent(name, schema, modules);
  registerRateLimiter(t, `${name}/rateLimiter`);
}
export default { registerEmail, schema, modules };
