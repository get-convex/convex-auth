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
import { RawResendOTPPasswordReset } from "./passwordReset/RawResendOTPPasswordReset";
// !publish: remove
import { FakePhone } from "./otp/FakePhone";
import type { AuthTriggers } from "@convex-dev/auth/server";
import { DataModel } from "./_generated/dataModel.js";

// Trigger configuration for testing - logs all auth table operations
const triggers: AuthTriggers = {
  users: {
    onCreate: async (ctx, doc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "users:onCreate",
        docId: doc._id,
        timestamp: Date.now(),
      });
    },
    onUpdate: async (ctx, newDoc, oldDoc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "users:onUpdate",
        docId: newDoc._id,
        timestamp: Date.now(),
        oldDocId: oldDoc._id,
      });
    },
    onDelete: async (ctx, id, _doc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "users:onDelete",
        docId: id,
        timestamp: Date.now(),
      });
    },
  },
  authAccounts: {
    onCreate: async (ctx, doc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "authAccounts:onCreate",
        docId: doc._id,
        timestamp: Date.now(),
      });
    },
    onUpdate: async (ctx, newDoc, oldDoc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "authAccounts:onUpdate",
        docId: newDoc._id,
        timestamp: Date.now(),
        oldDocId: oldDoc._id,
      });
    },
    onDelete: async (ctx, id, _doc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "authAccounts:onDelete",
        docId: id,
        timestamp: Date.now(),
      });
    },
  },
  authSessions: {
    onCreate: async (ctx, doc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "authSessions:onCreate",
        docId: doc._id,
        timestamp: Date.now(),
      });
    },
    onUpdate: async (ctx, newDoc, oldDoc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "authSessions:onUpdate",
        docId: newDoc._id,
        timestamp: Date.now(),
        oldDocId: oldDoc._id,
      });
    },
    onDelete: async (ctx, id, _doc) => {
      await ctx.db.insert("triggerLog", {
        trigger: "authSessions:onDelete",
        docId: id,
        timestamp: Date.now(),
      });
    },
  },
};

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  triggers,
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
    Password({ id: "password-raw-reset", reset: RawResendOTPPasswordReset }),
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
