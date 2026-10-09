import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "../components/email/schema.ts";
const modules = import.meta.glob("../components/email/**/*.ts");

// The email scheme sends email through `@convex-dev/resend`. Its test stub
// ships with the email component helpers.
export {
  registerResendStub,
  sentEmails,
  stubEmailSender,
  type SentEmail,
} from "./resend.ts";

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
  registerBatchWorker(t, `${name}/batchWorker`);
  registerRateLimiter(t, `${name}/rateLimiter`);
}
export default { registerEmail, schema, modules };
