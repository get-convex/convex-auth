import { Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";

export const passkeyCredentialsArgs = v.object({
  provider: v.string(),
  email: v.string(),
});

export type PasskeyCredentialDescriptor = {
  id: string;
  transports?: string[];
};

// Look up the passkeys belonging to the user(s) with a given email so the
// authentication flow can hint them via `allowCredentials`. This intentionally
// reveals whether an email has passkeys (account enumeration) — it is gated by
// the provider's `allowCredentialsByIdentifier` option.
export async function passkeyCredentialsImpl(
  ctx: MutationCtx,
  args: Infer<typeof passkeyCredentialsArgs>,
): Promise<PasskeyCredentialDescriptor[]> {
  const users = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", args.email))
    .collect();
  const credentials: PasskeyCredentialDescriptor[] = [];
  for (const user of users) {
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", user._id).eq("provider", args.provider),
      )
      .collect();
    for (const account of accounts) {
      let transports: string[] | undefined;
      try {
        transports = (JSON.parse(account.secret ?? "{}") as { transports?: string[] })
          .transports;
      } catch {
        transports = undefined;
      }
      credentials.push({ id: account.providerAccountId, transports });
    }
  }
  return credentials;
}

export const callPasskeyCredentials = async (
  ctx: ActionCtx,
  args: Infer<typeof passkeyCredentialsArgs>,
): Promise<PasskeyCredentialDescriptor[]> => {
  return ctx.runMutation("auth:store" as any, {
    args: { type: "passkeyCredentials", ...args },
  });
};
