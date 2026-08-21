import {
  vSignInSuccess,
  type SignInSuccess,
  type AnyUserCallback,
  type OnSignInFn,
  type UserCallbacksFor,
} from "../../lib/types";
import type { AuthCore } from "../core/setup";
import { ComponentApi } from "./_generated/component";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "anonymous";

/** An anonymous account carries nothing about the user. */
type AnonymousProfile = Record<string, never>;

/**
 * An anonymous accounts provider.
 *
 * Useful to establish an authenticated session without requiring a user
 * to provide any credentials.
 *
 * There is no support for allowing a user to return with a previously issued
 * anonymous account.
 *
 * ```ts
 * const core = setupCore({ component: components.core });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * const anonymous = setupAnonymous(core, {
 *   component: components.authAnonymous,
 * });
 * anonymous.attachUserCallbacks({ createUser: internal.users.createUserAnonymous });
 * export const { signInAnonymous } = anonymous.exports;
 * ```
 */
export function setupAnonymous<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: {
    /** The mounted anonymous component (`components.authAnonymous`). */
    component: ComponentApi;
  },
) {
  const { component } = options;

  const attach = (createUser: AnyUserCallback, onSignIn?: AnyUserCallback) => {
    const { authMutation } = core.bindProvider<AnonymousProfile>({
      name: PROVIDER_NAME,
      createUser,
      onSignIn,
    });

    return {
      // Anonymous sign-in cannot fail per-user, so this only ever produces
      // the success arm. It still returns the shared envelope rather than a
      // bare bundle: that is the shape the SSR auth proxy recognizes (and
      // validates before moving the refresh token into its cookie), and it
      // leaves room for a `userError` arm later without another breaking
      // change.
      signInAnonymous: authMutation({
        args: {},
        returns: vSignInSuccess,
        handler: async (ctx): Promise<SignInSuccess> => {
          const anonymousId = await ctx.runMutation(
            component.provider.createAnonymousAccount,
            {},
          );
          const tokens = await ctx.convexAuth.completeSignUp({
            providerAccountId: anonymousId,
            profile: {},
          });
          return { success: true, tokens };
        },
      }),
    };
  };

  let attached: ReturnType<typeof attach> | undefined;

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacksFor} for how
     * their args must be declared). The provider's functions are available on
     * {@link exports} afterwards.
     *
     * Because this call is generic (that is what checks that the callbacks
     * *accept* what this provider sends, so one mutation can serve several
     * providers), its result cannot feed an `export` in the same module that
     * `internal` is generated from — TypeScript would have to type the
     * module's exports in terms of themselves (TS7022). Call it as its own
     * statement and export from `exports`, which is not generic.
     *
     * Every anonymous sign-in establishes a new account, so `createUser` runs
     * every time. An `onSignIn` is still worth attaching for work an app does
     * on every sign-in whatever the provider, since it runs right afterwards.
     */
    attachUserCallbacks<
      CreateUser extends AnyUserCallback,
      OnSignIn extends AnyUserCallback = OnSignInFn<
        "anonymous",
        AnonymousProfile,
        UsersTable
      >,
    >({
      createUser,
      onSignIn,
    }: UserCallbacksFor<
      CreateUser,
      OnSignIn,
      "anonymous",
      AnonymousProfile,
      UsersTable
    >): void {
      attached = attach(createUser, onSignIn);
    },

    /**
     * The provider's functions to export, available once
     * {@link attachUserCallbacks} has run. Accessing them earlier throws, so
     * a module that forgets to attach callbacks fails at eval (push) time,
     * not at the first sign-in.
     */
    get exports() {
      if (attached === undefined) {
        throw new Error(
          "Call attachUserCallbacks before accessing the anonymous " +
            "provider's exports.",
        );
      }
      return attached;
    },
  };
}
