import GitHub, { GitHubProfile } from "@auth/core/providers/github";
import Google, { GoogleProfile } from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import { convexAuth } from "@xixixao/convex-auth/server";
import { ResendOTP } from "./otp/ResendOTP";
import Password from "@xixixao/convex-auth/providers/Password";
import { ResendOTPPasswordReset } from "./passwordReset/ResendOTPPasswordReset";
import type { DataModel, Doc, Id } from "./_generated/dataModel";

export const { auth, signIn, verifyCode, signOut, store } = convexAuth<
  DataModel,
  Id<"users">
>(
  {
    providers: [
      GitHub,
      Google,
      Resend,
      ResendOTP,
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
  },
  async (ctx, { profile, provider, userId }) => {
    const fields: Partial<Doc<"users">> = {};
    if (profile.name) fields.name = profile.name;
    let emailVerified = !!profile.email_verified;
    switch (provider.id) {
      case "github":
        // GitHub oauth requires verifying email
        emailVerified = true;
        break;
      case "google":
        fields.phone = (profile as GoogleProfile).phone ?? undefined;
        break;
      case "resend":
      case "resend-otp":
      case "password-code":
      case "password-link":
        // The email will be verified before the user is logged in
        // so let's treat it as such..
        emailVerified = true;
        break;
    }
    // Check for an existing user with the same email to merge
    const existingUserById = userId && (await ctx.db.get(userId));
    if (emailVerified) {
      const userWithVerifiedEmail = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", profile.email))
        .filter((q) => q.eq(q.field("emailVerified"), true))
        .unique();
      if (userWithVerifiedEmail && userWithVerifiedEmail._id !== userId) {
        // patch any fields that might be useful from the new signin
        await ctx.db.patch(userWithVerifiedEmail._id, fields);
        if (existingUserById) {
          // merge accounts: assign anything from the old account to the new one
          // then get rid of this one that just verified email.
          await ctx.db.delete(userId);
        }
        return userWithVerifiedEmail?._id;
      }
    }
    // Update the existing user or create a new one
    if (existingUserById) {
      await ctx.db.patch(userId, { ...fields, emailVerified });
      return userId;
    }
    return ctx.db.insert("users", {
      name: profile.name ?? undefined,
      image: profile.image ?? undefined,
      email: profile.email,
      emailVerified,
      ...fields,
    });
  },
);
