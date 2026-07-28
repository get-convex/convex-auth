import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "../emailValidation/schema";
const modules = import.meta.glob("../emailValidation/**/*.ts");

/**
 * Register the email-validation component with a `convex-test` instance.
 *
 * The component throttles both sends and confirmations through a nested
 * rate-limiter, so we register that under `<name>/rateLimiter` too — mirroring
 * how it's mounted when the app `app.use`s the provider's `convex.config`.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerEmailValidation(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authEmailValidation",
) {
  t.registerComponent(name, schema, modules);
  registerRateLimiter(t, `${name}/rateLimiter`);
}
export default { registerEmailValidation, schema, modules };
