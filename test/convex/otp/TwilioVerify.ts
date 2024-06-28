import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { internal } from "../_generated/api";
import { DataModel } from "../_generated/dataModel";

/**
 * Uses Twilio Verify service.
 *
 * Sign up for Twilio, create a Verify service, and then configure
 * these Convex environment variables:
 * - AUTH_TWILIO_ACCOUNT_SID
 * - AUTH_TWILIO_AUTH_TOKEN
 * - AUTH_TWILIO_SERVICE_SID
 */
export function TwilioVerify() {
  return ConvexCredentials<DataModel>({
    id: "twilio",
    authorize: async (params, ctx) => {
      if (params.phone === undefined) {
        throw new Error("`phone` param is missing for Twilio");
      }
      return await ctx.runAction(internal.otp.TwilioSDK.verify, {
        phone: params.phone as string,
        code: params.code as string | undefined,
      });
    },
  });
}
