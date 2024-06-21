import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import { convexAuth } from "@xixixao/convex-auth/server";
import { ResendOTP } from "./otp/ResendOTP";
import Password from "@xixixao/convex-auth/providers/Password";
import { ResendOTPPasswordReset } from "./passwordReset/ResendOTPPasswordReset";
import { FakePhone } from "./otp/FakePhone";

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    GitHub,
    GitHub({ id: "github-verified", allowDangerousEmailAccountLinking: true }),
    Google,
    Resend,
    ResendOTP,
    FakePhone,
    FakePhone({ id: "fake-phone-2" }),
    Password,
    Password({ id: "password-with-reset", reset: ResendOTPPasswordReset }),
    Password({
      id: "password-code",
      reset: ResendOTPPasswordReset,
      verify: ResendOTP,
    }),
    Password({ id: "password-link", verify: Resend }),
  ],
  // session: {
  //   inactiveDurationMs: 1000 * 60 * 1, // 1 minute
  // },
  // jwt: {
  //   durationMs: 1000 * 20, // 20 seconds
  // },
});
