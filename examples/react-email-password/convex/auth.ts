import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupEmailPassword } from "@convex-dev/auth/providers/email-password/setup";

// The frontend origin the emailed links point at. Set SITE_URL on the
// deployment when the frontend does not run on the Vite default.
const SITE_URL = process.env.SITE_URL ?? "http://localhost:5173";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const {
  signUp,
  completeSignUp,
  signIn,
  changePassword,
  startChangeEmail,
  completeChangeEmail,
  startRecovery,
  completeRecovery,
  getChallengeStatus,
} = setupEmailPassword(core, {
  component: components.authEmail,
  passwordComponent: components.authPasswordProvider,
  emailSender: {
    kind: "resend",
    sendEmail: components.resend.lib.sendEmail,
    // Resend's shared onboarding sender; replace it with a sender on
    // your own verified domain.
    from: "My App <onboarding@resend.dev>",
    // Test mode only delivers to Resend test addresses (e.g.
    // delivered@resend.dev). Set it to false to send real email.
    testMode: true,
  },
  urls: {
    signUp: `${SITE_URL}/validate-email`,
    changeEmail: `${SITE_URL}/confirm-email-change`,
    recovery: `${SITE_URL}/reset-password`,
  },
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
