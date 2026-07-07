import { CompleteSignInFunc, defineProvider } from "../../../src/lib/types";
import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup.js";

const FooProvider = defineProvider({
  name: "foo",
  setup: (completeSignIn, options: { x: string }) => {
    return {
      login: () => null,
    };
  },
});

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `upsertFromAuth` on every sign-in; this example owns no users table and just
// echoes the account id back as the app user id.
export const { signOut, refreshSession, providers } = setupCore({
  component: components.core,
  providers: [
    provider(FooProvider, { x: "value" }),
    provider(
      {
        name: "bar",
        setup: (completeSignIn: CompleteSignInFunc, options: { x: number }) => {
          return { x: "hi" };
        },
      },
      { x: 2 },
    ),
  ],
}).attachUserCallback(internal.users.upsertFromAuth);

const { foo, bar } = providers;
