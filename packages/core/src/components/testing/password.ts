import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "../password/schema";
const modules = import.meta.glob("../password/**/*.ts");

/**
 * Register the password provider component with a `convex-test` instance.
 *
 * The component throttles `verifyPassword` through a nested rate-limiter, so we
 * register that under `<name>/rateLimiter` too — mirroring how it's mounted when
 * the app `app.use`s the provider's `convex.config`.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerPasswordProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authPasswordProvider",
) {
  t.registerComponent(name, schema, modules);
  registerRateLimiter(t, `${name}/rateLimiter`);
}
export default { registerPasswordProvider, schema, modules };
