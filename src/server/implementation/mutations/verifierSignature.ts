import { GenericId, Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";

export const verifierSignatureArgs = v.object({
  verifier: v.string(),
  signature: v.string(),
});

type ReturnType = void;

export async function verifierSignatureImpl(
  ctx: MutationCtx,
  args: Infer<typeof verifierSignatureArgs>,
): Promise<ReturnType> {
  const { verifier, signature } = args;
  const verifierDoc = await ctx.db.get(verifier as GenericId<"authVerifiers">);
  if (verifierDoc === null) {
    throw new Error("Invalid verifier");
  }
  return await ctx.db.patch(verifierDoc._id, { signature });
}

export const callVerifierSignature = async (
  ctx: ActionCtx,
  args: Infer<typeof verifierSignatureArgs>,
): Promise<void> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "verifierSignature",
      ...args,
    },
  });
};
