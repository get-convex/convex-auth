import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./resendStub/schema.ts";
const modules = import.meta.glob("./resendStub/**/*.ts");

/**
 * Register a stub of the `@convex-dev/resend` component with a
 * `convex-test` instance.
 *
 * The stub records each email in its `emails` table instead of sending
 * it. Tests read the table through `t.runInComponent` to make
 * assertions about the sent emails.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerResendStub(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "resend",
) {
  t.registerComponent(name, schema, modules);
}
export default { registerResendStub, schema, modules };
