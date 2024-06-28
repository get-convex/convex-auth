import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import Password from "@convex-dev/auth/providers/Password";
import Anonymous from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";
import { ResendOTP } from "./otp/ResendOTP";
import TwilioVerify from "./otp/Twilio";
import TwilioOTP from "./otp/TwilioOTP";
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
    Resend,
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
});
