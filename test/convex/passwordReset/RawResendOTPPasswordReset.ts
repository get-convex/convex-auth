import { EmailConfig } from "@convex-dev/auth/server";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";
import { Resend as ResendAPI } from "resend";
import { PasswordResetEmail } from "./PasswordResetEmail";

// Raw EmailConfig without the Email() wrapper — no authorize function.
// This mirrors what real users do when building custom email providers.
export const RawResendOTPPasswordReset: EmailConfig = {
  id: "raw-resend-otp-password-reset",
  type: "email",
  name: "Email",
  from: "My App <onboarding@resend.dev>",
  maxAge: 60 * 60,
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes) {
        crypto.getRandomValues(bytes);
      },
    };

    const alphabet = "0123456789";
    const length = 8;
    return generateRandomString(random, alphabet, length);
  },
  async sendVerificationRequest({
    identifier: email,
    token,
    expires,
  }) {
    const resend = new ResendAPI(process.env.AUTH_RESEND_KEY);
    const { error } = await resend.emails.send({
      from: process.env.AUTH_EMAIL ?? "My App <onboarding@resend.dev>",
      to: [email],
      subject: `Reset password in My App`,
      react: PasswordResetEmail({ code: token, expires }),
    });

    if (error) {
      throw new Error(JSON.stringify(error));
    }
  },
  options: {},
};
