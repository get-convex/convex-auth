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
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import schema from "../passkey/schema.ts";
const modules = import.meta.glob("../passkey/**/*.ts");

/**
 * Register the passkey provider component with a `convex-test` instance.
 *
 * The component mounts the batch worker for its cleanup loop, so we register
 * that under `<name>/batchWorker` too — the same way it sits below the
 * component when the app `app.use`s the provider's `convex.config`.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerPasskeyProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authPasskey",
) {
  t.registerComponent(name, schema, modules);
  registerBatchWorker(t, `${name}/batchWorker`);
}

// The software authenticator that the tests of this repo drive. It ships with
// the other testing helpers so that an app can write its own passkey tests.
export * from "../passkey/testAuthenticator.ts";

export default { registerPasskeyProvider, schema, modules };
