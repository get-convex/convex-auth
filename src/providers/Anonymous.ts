/**
 * Configure {@link Anonymous} provider given an {@link AnonymousConfig}.
 *
 * ```ts
 * import Anonymous from "@xixixao/convex-auth/providers/Anonymous";
 * import { convexAuth } from "@xixixao/convex-auth/server";
 *
 * export const { auth, signIn, signOut, store } = convexAuth({
 *   providers: [Anonymous],
 * });
 * ```
 *
 * @module
 */

import ConvexCredentials from "@xixixao/convex-auth/providers/ConvexCredentials";
import {
  GenericActionCtxWithAuthConfig,
  createAccount,
} from "@xixixao/convex-auth/server";
import {
  DocumentByName,
  GenericDataModel,
  WithoutSystemFields,
} from "convex/server";
import { Value } from "convex/values";

/**
 * The available options to an {@link Anonymous} provider for Convex Auth.
 */
export interface AnonymousConfig<DataModel extends GenericDataModel> {
  /**
   * Uniquely identifies the provider, allowing to use
   * multiple different {@link Anonymous} providers.
   */
  id?: string;
  /**
   * Perform checks on provided params and customize the user
   * information stored after sign in.
   */
  profile?: (
    /**
     * The values passed to the `signIn` function.
     */
    params: Record<string, Value | undefined>,
    /**
     * Convex ActionCtx in case you want to read from or write to
     * the database.
     */
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => WithoutSystemFields<DocumentByName<DataModel, "users">> & {
    isAnonymous: true;
  };
}

/**
 * An anonymous authentication provider.
 *
 * This provider doesn't require any user-provided information.
 */
export default function Anonymous<DataModel extends GenericDataModel>(
  config: AnonymousConfig<DataModel> = {},
) {
  const provider = config.id ?? "anonymous";
  return ConvexCredentials<DataModel>({
    id: "anonymous",
    authorize: async (params, ctx) => {
      const profile = config.profile?.(params, ctx) ?? { isAnonymous: true };
      const { user } = await createAccount(ctx, {
        provider,
        account: { id: crypto.randomUUID() },
        profile: profile as any,
      });
      // END
      return { userId: user._id };
    },
    ...config,
  });
}
