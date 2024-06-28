import { Phone } from "@convex-dev/auth/providers/Phone";
import { internal } from "../_generated/api";
import { alphabet, generateRandomString } from "oslo/crypto";

/**
 * Uses Twilio messaging to send an OTP code.
 *
 * You can only send messages to Verified Caller IDs during the
 * Twilio trial period.
 *
 * Sign up for Twilio, get a phone number, and then configure
 * these Convex environment variables:
 * - AUTH_TWILIO_ACCOUNT_SID
 * - AUTH_TWILIO_AUTH_TOKEN
 * - AUTH_TWILIO_FROM_NUMBER
 */
export const TwilioOTP = Phone({
  id: "twilio-otp",
  maxAge: 60 * 20, // 20 minutes
  async generateVerificationToken() {
    return generateRandomString(6, alphabet("0-9"));
  },
  async sendVerificationRequest({ identifier: phone, token }, ctx) {
    if (process.env.AUTH_TWILIO_FROM_NUMBER === undefined) {
      throw new Error("AUTH_TWILIO_FROM_NUMBER is missing for twilio-otp");
    }
    if (phone === undefined) {
      throw new Error("`phone` param is missing for twilio-otp");
    }
    await ctx.runAction(internal.otp.TwilioSDK.message, {
      from: process.env.AUTH_TWILIO_FROM_NUMBER,
      to: phone,
      code: token,
    });
  },
});
