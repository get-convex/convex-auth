// The `convex` email sender: the emails go through Convex's email service
// (auth-emails), a Convex deployment that renders fixed templates and sends them
// from a Convex address.
//
// The service authenticates the calling deployment with its service token,
// which only an action can get. A mutation that sends an email thus
// schedules `deliver`, and the email leaves after the mutation commits.

import { ConvexHttpClient } from "convex/browser";
import { getServiceToken } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.ts";
import {
  internalAction,
  mutation,
  type MutationCtx,
} from "./_generated/server.ts";
import {
  authEmailsApi,
  sendArgs,
  vTemplate,
  type Template,
} from "./authEmailsApi.ts";
import {
  vConvexEmailSenderConfig,
  type ConvexEmailSenderConfig,
} from "./validation.ts";

/** Schedule one email through the service. */
export async function scheduleConvexEmail(
  ctx: MutationCtx,
  sender: ConvexEmailSenderConfig,
  to: string,
  template: Template,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.authEmailsService.deliver, {
    url: sender.url,
    to,
    appName: sender.appName,
    template,
  });
}

/**
 * Send a security notification through the service. The recipe calls it,
 * since it runs in the app and cannot schedule this component's functions.
 */
export const sendNotification = mutation({
  args: {
    emailSender: vConvexEmailSenderConfig,
    to: v.string(),
    template: vTemplate,
  },
  returns: v.null(),
  handler: async (ctx, { emailSender, to, template }) => {
    await scheduleConvexEmail(ctx, emailSender, to, template);
    return null;
  },
});

export const deliver = internalAction({
  args: { url: v.string(), ...sendArgs },
  returns: v.null(),
  handler: async (_ctx, { url, ...args }) => {
    // TODO: use a dedicated `getServiceToken("auth-emails")` token once the
    // backend mints one.
    const token = await getServiceToken("ai-gateway");
    const client = new ConvexHttpClient(url, {
      // The production service has a custom domain.
      skipConvexDeploymentUrlCheck: true,
      logger: false,
    });
    client.setAuth(token);
    const result = await client.mutation(authEmailsApi.emails.send, args);
    if (result.status === "rateLimited") {
      // Retrying later would deliver a link that may have expired, or a
      // notification long after the change, so the email is dropped.
      console.warn(
        `The Convex email service rate-limited a "${args.template.kind}" ` +
          `email. Retry after ${result.retryAfterMs} ms.`,
      );
    }
    return null;
  },
});
