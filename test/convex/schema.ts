import { migrationsTable } from "convex-helpers/server/migrations";
import { v } from "convex/values";
import {
  defineEnt,
  defineEntFromTable,
  defineEntSchema,
  getEntDefinitions,
} from "convex-ents";

const schema = defineEntSchema(
  {
    migrations: defineEntFromTable(migrationsTable),
    messages: defineEnt({
      text: v.string(),
    })
      .edge("user")
      .edges("tags")
      .edges("messageDetails", { ref: true }),

    users: defineEnt({
      name: v.string(),
    })
      .field("email", v.string(), { unique: true })
      .field("height", v.optional(v.number()), { index: true })
      .edge("profile", { optional: true })
      .edges("messages", { ref: true })
      .edges("followers", { to: "users", inverse: "followees" })
      .edges("friends", { to: "users" })
      .edge("secret", { ref: "ownerId", optional: true }),

    profiles: defineEnt({
      bio: v.string(),
    }).edge("user"),

    tags: defineEnt({
      name: v.string(),
    }).edges("messages"),

    posts: defineEnt({
      text: v.string(),
    })
      .field("numLikes", v.number(), { default: 0 })
      .field("type", v.union(v.literal("text"), v.literal("video")), {
        default: "text",
      })
      .index("numLikesAndType", ["type", "numLikes"])
      .searchIndex("text", {
        searchField: "text",
        filterFields: ["type"],
      })
      .edge("attachment", { ref: "originId", optional: true })
      .edge("secondaryAttachment", {
        ref: "copyId",
        to: "attachments",
        optional: true,
      })
      .edges("allAttachments", { to: "attachments", ref: "shareId" })
      .edges("anyAttachments", {
        to: "attachments",
        table: "posts_to_anyattachments",
      })
      .edges("anyAttachments2", {
        to: "attachments",
        table: "posts_to_anyattachments2",
        field: "owningPostId",
      }),

    attachments: defineEnt({})
      .edge("origin", { to: "posts", field: "originId" })
      .edge("copy", { to: "posts", field: "copyId" })
      .edge("share", { to: "posts", field: "shareId" })
      .edges("in", { to: "posts", table: "posts_to_anyattachments" })
      .edges("in2", {
        to: "posts",
        table: "posts_to_anyattachments2",
        field: "attachId",
      })
      .edges("siblings", { to: "attachments", table: "attachment_to_siblings" })
      .edges("replaced", {
        to: "attachments",
        inverse: "replacing",
        table: "attachment_to_replaced",
      })
      .edges("siblings2", {
        to: "attachments",
        table: "attachment_to_siblings2",
        field: "sibling1Id",
        inverseField: "sibling2Id",
      })
      .edges("replaced2", {
        to: "attachments",
        inverse: "replacing2",
        table: "attachment_to_replaced2",
        field: "r1Id",
        inverseField: "r2Id",
      }),

    secrets: defineEnt({
      value: v.string(),
    }).edge("user", { field: "ownerId" }),

    messageDetails: defineEnt({
      value: v.string(),
    }).edge("message"),

    teams: defineEnt({})
      .edges("members", { ref: true, deletion: "soft" })
      .deletion("scheduled"),

    members: defineEnt({})
      .edge("team")
      .edges("datas", { ref: true })
      .deletion("soft"),

    datas: defineEnt({}).edge("member"),
  },
  { schemaValidation: true },
);

export default schema;

export const entDefinitions = getEntDefinitions(schema);
