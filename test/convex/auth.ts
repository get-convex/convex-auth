import { INVALID_PASSWORD } from "./errors.js";
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import Apple from "@auth/core/providers/apple";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";
import { convexAuth } from "@convex-dev/auth/server";
import { ResendOTP } from "./otp/ResendOTP";
import { TwilioOTP } from "./otp/TwilioOTP";
import { TwilioVerify } from "./otp/TwilioVerify";
import { ResendOTPPasswordReset } from "./passwordReset/ResendOTPPasswordReset";
// !publish: remove
import { FakePhone } from "./otp/FakePhone";
import { DataModel } from "./_generated/dataModel.js";
import type { AuthTableName } from "@convex-dev/auth/server";
import { GenericMutationCtx } from "convex/server";

// Helper to create logged triggers with auto-derived names
function loggedTriggers<T extends AuthTableName>(table: T) {
  return {
    onCreate: async (ctx: GenericMutationCtx<DataModel>, doc: { _id: string }) => {
      await ctx.db.insert("triggerLog", {
        trigger: `${table}:onCreate` as const,
        docId: doc._id,
        timestamp: Date.now(),
      });
    },
    onUpdate: async (
      ctx: GenericMutationCtx<DataModel>,
      newDoc: { _id: string },
      oldDoc: { _id: string },
    ) => {
      await ctx.db.insert("triggerLog", {
        trigger: `${table}:onUpdate` as const,
        docId: newDoc._id,
        timestamp: Date.now(),
        oldDocId: oldDoc._id,
      });
    },
  };
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  triggers: {
    users: loggedTriggers("users"),
    authAccounts: loggedTriggers("authAccounts"),
  },
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
    // Sample password auth with a custom parameter provided during sign-up
    // flow and custom password validation requirements (at least six chars
    // with at least one number, upper and lower case chars).
    Password<DataModel>({
      id: "password-custom",
      profile(params, _ctx) {
        return {
          email: params.email as string,
          favoriteColor: params.favoriteColor as string,
        };
      },
      validatePasswordRequirements: (password: string) => {
        if (
          !password ||
          password.length < 6 ||
          !/\d/.test(password) ||
          !/[a-z]/.test(password) ||
          !/[A-Z]/.test(password)
        ) {
          throw new ConvexError(INVALID_PASSWORD);
        }
      },
    }),
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
