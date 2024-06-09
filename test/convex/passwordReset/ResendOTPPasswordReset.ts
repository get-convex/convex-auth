import Resend from "@auth/core/providers/resend";
import { ConvexError } from "convex/values";
import { alphabet, generateRandomString } from "oslo/crypto";

export const ResendOTPPasswordReset = Resend({
  id: "resend-otp-password-reset",
  async generateVerificationToken() {
    return generateRandomString(8, alphabet("0-9"));
  },
  async sendVerificationRequest({
    identifier: email,
    provider,
    token,
    expires,
  }) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "My App <onboarding@resend.dev>",
        to: [email],
        subject: `Reset password in My App`,
        text: `Your code is ${token}. This code is valid for ${Math.floor(
          (+expires - Date.now()) / (60 * 1000),
        )} minutes.`,
      }),
    });

    if (!response.ok) {
      throw new ConvexError("Could not send verification code email");
    }
  },
});
