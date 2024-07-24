import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import Apple from "@auth/core/providers/apple";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ResendOTP } from "./otp/ResendOTP";
import { TwilioOTP } from "./otp/TwilioOTP";
import { TwilioVerify } from "./otp/TwilioVerify";
import { ResendOTPPasswordReset } from "./passwordReset/ResendOTPPasswordReset";
// !publish: remove
import { FakePhone } from "./otp/FakePhone";

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    // !publish: remove
    FakePhone,
    // !publish: remove
    FakePhone({ id: "fake-phone-2" }),
    GitHub,
    Google,
    Apple({
      clientSecret: process.env.AUTH_APPLE_SECRET!,
      client: {
        token_endpoint_auth_method: "client_secret_post",
      },
      profile: undefined,
    }),
    Resend({
      from: process.env.AUTH_EMAIL ?? "My App <onboarding@resend.dev>",
    }),
    ResendOTP,
    TwilioVerify,
    TwilioOTP,
    Password,
    Password({ id: "password-with-reset", reset: ResendOTPPasswordReset }),
    Password({
      id: "password-code",
      reset: ResendOTPPasswordReset,
      verify: ResendOTP,
    }),
    // This one only makes sense with routing, ignore for now:
    Password({ id: "password-link", verify: Resend }),
    Anonymous,
  ],
  session: {
    inactiveDurationMs: 1000 * 60 * 2,
  },
});
