import type { GenericMutationCtx, AnyDataModel } from "convex/server";
import type { ConvexEmailSenderConfig } from "../components/email/validation.ts";
import type { SendArgs } from "../components/email/authEmailsApi.ts";

type Run = <Output>(
  handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
) => Promise<Output>;

/** The part of a `convex-test` instance that this helper uses. */
type T = { run: Run };

/**
 * A `convex` sender config for the `start` mutations of the email component.
 * The URL is never called: tests read the scheduled emails with
 * {@link scheduledConvexEmails} instead.
 */
export function convexEmailSender(
  options: { appName?: string } = {},
): ConvexEmailSenderConfig {
  return { kind: "convex", url: "https://auth-emails.test", ...options };
}

/**
 * The emails that the `convex` sender scheduled, oldest first, as the
 * arguments that Convex's email service receives.
 *
 * The email component schedules an action that calls the service. The
 * action fails under `convex-test`, which cannot mint the service token, so
 * this reads the arguments of the scheduled actions instead.
 *
 * `convex-test` exposes `runInComponent` at runtime but does not declare
 * it, hence the cast.
 *
 * @param t - The test convex instance.
 * @param name - The name of the email component, as registered in
 * convex.config.ts, or `null` when the test instance is the component itself.
 */
export function scheduledConvexEmails(
  t: T,
  name: string | null = "authEmail",
): Promise<SendArgs[]> {
  const testApi = t as unknown as T & {
    runInComponent<Output>(
      componentPath: string,
      handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
    ): Promise<Output>;
  };
  const run: Run =
    name === null
      ? (handler) => testApi.run(handler)
      : (handler) => testApi.runInComponent(name, handler);
  return run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs
      .filter((job) => /^authEmailsService(\.js)?:deliver$/.test(job.name))
      .map((job) => {
        const { url: _url, ...args } = job.args[0] as SendArgs & {
          url: string;
        };
        return args;
      });
  });
}

export default { convexEmailSender, scheduledConvexEmails };
