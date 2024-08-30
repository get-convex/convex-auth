import { GenericId } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import { getAuthSessionId } from "../sessions.js";

type ReturnType = GenericId<"authVerifiers">;

export async function verifierImpl(ctx: MutationCtx): Promise<ReturnType> {
  return await ctx.db.insert("authVerifiers", {
    sessionId: (await getAuthSessionId(ctx)) ?? undefined,
  });
}

export const callVerifier = async (ctx: ActionCtx): Promise<ReturnType> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "verifier",
    },
  });
};
