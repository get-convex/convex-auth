import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupUsernamePassword } from "@convex-dev/auth/providers/password/setup";
import { setupTotp } from "@convex-dev/auth/totp/setup";

const core = setupCore({ component: components.auth });
// `continueSignIn` finishes a sign-in that the password provider held for a
// TOTP code, once the code has been verified.
export const { signOut, refreshSession, isAuthenticated, continueSignIn } =
  core;

export const { signUpWithPassword, signInWithPassword, changePassword } =
  setupUsernamePassword(core, {
    component: components.authPasswordProvider,
    usernameComponent: components.authUsername,
    // Users who enroll a TOTP authenticator must give a code at sign-in.
    totp: { component: components.authTotp },
  }).attachUserCallbacks({ createUser: internal.users.createUser });

// The TOTP second factor. `verifyTotpForSignIn` is the step of a held sign-in
// where the client verifies a code for the attempt, before `continueSignIn`.
// The rest is the signed-in user's own authenticator: enrolling an app,
// turning it off, and renewing backup codes.
export const {
  verifyTotpForSignIn,
  getTotpStatus,
  startTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  regenerateBackupCodes,
} = setupTotp(core, {
  component: components.authTotp,
  issuer: "Convex Auth v2 Password Example",
});
