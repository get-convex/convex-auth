import type { ComponentApi as ResendComponentApi } from "@convex-dev/resend/_generated/component.js";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { setupCore } from "../../components/core/setup";
import { UsernamePassword } from "../../components/password/setup";
import { emailValidation } from "../../components/emailValidation/setup";

// Stand-in for the mounted resend component: its `lib.sendEmail` points at the
// test spy in `resendSpy.ts`, so the full flow runs without sending real email.
// A real app would pass `components.resend` here.
const resend = {
  lib: { sendEmail: internal.resendSpy.sendEmail },
} as unknown as ResendComponentApi;

// Wires the core with the password provider in email mode. `withOptions` (rather
// than `provider()`) is required for email mode so the resolved API includes
// `confirmEmail`. `emailValidation<DataModel>` enforces, at compile time, that
// `users.email` is declared `v.optional(v.string())`.
export const {
  signOut,
  refreshSession,
  providers: {
    password: { signUpWithPassword, confirmEmail, signInWithPassword },
  },
} = setupCore({
  component: components.core,
  providers: [
    UsernamePassword.withOptions({
      mode: "email",
      component: components.authPasswordProvider,
      emailValidation: emailValidation<DataModel>({
        component: components.authEmailValidation,
        resend,
        from: "My App <auth@example.com>",
      }),
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
