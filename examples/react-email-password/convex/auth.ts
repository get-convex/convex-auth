import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupCore } from "@convex-dev/auth/server";
import {
  setupEmailPassword,
  type EmailSenderOptions,
} from "@convex-dev/auth/methods/email-password/server";

// The frontend origin the emailed links point at. Set SITE_URL on the
// deployment when the frontend does not run on the Vite default.
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";

// Send the emails through Convex's email service when
// CONVEX_EMAIL_SERVICE_URL is set, and through your own Resend account
// otherwise. The service needs no setup: in an app, write
// `emailSender: { kind: "convex", appName: "My App" }`. The URL is only for
// testing against a development deployment of the service.
const emailSender: EmailSenderOptions =
  env.CONVEX_EMAIL_SERVICE_URL !== undefined
    ? {
        kind: "convex",
        appName: env.SENDER_NAME ?? "My App",
        url: env.CONVEX_EMAIL_SERVICE_URL,
      }
    : {
        kind: "resend",
        sendEmail: components.resend.lib.sendEmail,
        // Unset values fail when Resend sends, not here: `convex codegen`
        // imports this file without the deployment's environment.
        apiKey: env.RESEND_API_KEY ?? "",
        // SENDER_EMAIL must be on a domain you verified with Resend, or
        // Resend's onboarding sender (onboarding@resend.dev), which only
        // delivers to the email address of your own Resend account.
        from: `${env.SENDER_NAME ?? "My App"} <${env.SENDER_EMAIL ?? ""}>`,
      };

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const {
  signUp,
  completeSignUp,
  signIn,
  changePassword,
  startChangeEmail,
  completeChangeEmail,
  startPasswordRecovery,
  checkPasswordRecovery,
  completePasswordRecovery,
} = setupEmailPassword(core, {
  component: components.authEmail,
  passwordComponent: components.authPassword,
  emailSender,
  urls: {
    signUp: `${SITE_URL}/validate-email`,
    changeEmail: `${SITE_URL}/confirm-email-change`,
    recovery: `${SITE_URL}/reset-password`,
  },
}).attachUserCallbacks({
  createUser: internal.users.createUser,
});
