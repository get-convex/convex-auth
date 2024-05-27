import { makeMigration } from "convex-helpers/server/migrations";
import { internalMutation } from "./_generated/server";
import { mutationCtx } from "./functions";

export const migration = makeMigration(internalMutation, {
  migrationTable: "migrations",
});

export const usersCapitalizeName = migration({
  table: "users",
  migrateOne: async (_, user) => ({
    name: user.name[0].toUpperCase() + user.name.slice(1),
  }),
  batchSize: 10,
});

export const usersTallUpdateProfile = migration({
  table: "users",
  migrateOne: async (baseCtx, doc) => {
    const ctx = await mutationCtx(baseCtx);
    const user = await ctx.table("users").getX(doc._id);
    if ((user.height ?? 0) > 3) {
      const profile = await user.edge("profile");
      if (profile === null) {
        await ctx
          .table("profiles")
          .insert({ bio: "I'm tall", userId: user._id });
      } else {
        // See https://github.com/xixixao/convex-ents/issues/8
        // await profile.patch({ bio: "I'm tall" });
        await ctx
          .table("profiles")
          .getX(profile._id)
          .patch({ bio: "I'm tall" });
      }
    }
  },
  batchSize: 10,
});
