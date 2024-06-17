import GitHub, { GitHubProfile } from "@auth/core/providers/github";
import Google, { GoogleProfile } from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import { convexAuth } from "@xixixao/convex-auth/server";
import { ResendOTP } from "./otp/ResendOTP";
import Password from "@xixixao/convex-auth/providers/Password";
import { ResendOTPPasswordReset } from "./passwordReset/ResendOTPPasswordReset";
import type { DataModel, Doc, Id } from "./_generated/dataModel";

type MyProfile = {
  id: string;
  name: string;
  email: string;
  image?: string;
  phone?: string;
  bio?: string;
  email_verified?: boolean;
};

export const { auth, signIn, verifyCode, signOut, store } = convexAuth<
  DataModel,
  Id<"users">
>(
  {
    providers: [
      GitHub({
        profile: (profile): MyProfile => ({
          id: profile.id.toString(),
          name: profile.name ?? profile.login,
          email: profile.email!,
          // GitHub oauth requires verifying email
          email_verified: true,
          image: profile.avatar_url,
          bio: profile.bio ?? undefined,
        }),
      }),
      Google({
        profile: (profile): MyProfile => ({
          id: profile.sub ?? profile.id,
          name: profile.name ?? profile.nickname ?? profile.preferred_username,
          email: profile.email,
          email_verified: !!profile.email_verified,
          image: profile.picture,
          phone: profile.phone,
        }),
      }),
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
  async (ctx, { profile: raw, provider, userId }) => {
    const fields: Partial<Doc<"users">> = {};
    const profile = raw as MyProfile;
    let emailVerified = !!profile.email_verified;
    switch (provider.id) {
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
        if (!userWithVerifiedEmail.name) {
          if (existingUserById?.name) fields.name = existingUserById.name;
          else if (profile.name) fields.name = profile.name;
        }
        if (!userWithVerifiedEmail.image) {
          if (existingUserById?.image) fields.image = existingUserById.image;
          else if (profile.image) fields.image = profile.image;
        }
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
      if (!existingUserById.name && profile.name) {
        fields.name = profile.name;
      }
      if (!existingUserById.image && profile.image) {
        fields.image = profile.image;
      }
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
