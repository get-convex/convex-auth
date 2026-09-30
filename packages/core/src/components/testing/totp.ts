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
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "../totp/schema.ts";
const modules = import.meta.glob("../totp/**/*.ts");

// Re-exported so that tests can compute the codes an authenticator app would
// show, and know how many backup codes an enrollment hands out.
export { totp } from "../totp/totp.ts";
export { BACKUP_CODE_COUNT } from "../totp/backupCodes.ts";

/**
 * Register the TOTP component with a `convex-test` instance.
 *
 * The component throttles code verification through a nested rate-limiter, so
 * we register that under `<name>/rateLimiter` too — mirroring how it's mounted
 * when the app `app.use`s the component's `convex.config`.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerTotp(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authTotp",
) {
  t.registerComponent(name, schema, modules);
  registerRateLimiter(t, `${name}/rateLimiter`);
}
export default { registerTotp, schema, modules };
