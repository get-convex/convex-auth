import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import { convexAuth } from "@xixixao/convex-auth/server";
import { ResendOTP } from "./otp/ResendOTP";
import Password from "@xixixao/convex-auth/providers/Password";
import { ResendOTPPasswordReset } from "./passwordReset/ResendOTPPasswordReset";
import TwilioVerify from "./otp/Twilio";
import TwilioOTP from "./otp/TwilioOTP";

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
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
  ],
});
