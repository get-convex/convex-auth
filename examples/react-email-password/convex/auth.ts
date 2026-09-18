import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupEmailPassword } from "@convex-dev/auth/providers/email-password/setup";

// The frontend origin the emailed links point at. Set SITE_URL on the
// deployment when the frontend does not run on the Vite default.
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";

// The From address. Resend's onboarding sender only delivers to the email
// address of your own Resend account; set EMAIL_FROM to an address on a
// domain you verified with Resend to email anyone.
const EMAIL_FROM = env.EMAIL_FROM ?? "My App <onboarding@resend.dev>";

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
} = setupEmailPassword(core, {
  component: components.authEmail,
  passwordComponent: components.authPasswordProvider,
  emailSender: {
    kind: "resend",
    sendEmail: components.resend.lib.sendEmail,
    // Declared in convex.config.ts; the README says how to set it.
    apiKey: env.RESEND_API_KEY,
    from: EMAIL_FROM,
    // Send real email. In test mode (the default) Resend only delivers to
    // its test addresses such as delivered@resend.dev.
    testMode: false,
  },
  urls: {
    signUp: `${SITE_URL}/validate-email`,
    changeEmail: `${SITE_URL}/confirm-email-change`,
    recovery: `${SITE_URL}/reset-password`,
  },
}).attachUserCallbacks({
  createUser: internal.users.createUser,
});
