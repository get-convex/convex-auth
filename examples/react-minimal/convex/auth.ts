import { defineProvider } from "@convex-dev/auth/lib/types.js";
import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup.js";

/**
 * Documentation for the FakeProvider.
 *
 * Pair with {@link FakeOptions} when installing as a {@link provider}.
 */
// TODO: dowski - remove this when we have real providers to work with
const FakeProvider = defineProvider({
  name: "fake",
  setup: (_completeSignIn, _options: FakeOptions) => {
    return {
      login: (_arg1: string) => null,
    };
  },
});

/**
 * Docs for the FakeOptions.
 */
type FakeOptions = {
  /**
   * Docs for the exampleValue.
   */
  exampleValue: string;
};

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `upsertFromAuth` on every sign-in from a provider.
export const { signOut, refreshSession, providers } = setupCore({
  component: components.core,
  providers: [
    // TODO: dowski - remove this when we have real providers to work with
    provider(FakeProvider, { exampleValue: "passed to FakeProvider.setup" }),
  ],
}).attachUserCallback(internal.users.upsertFromAuth);
