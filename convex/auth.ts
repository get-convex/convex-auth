import { Resend } from "@convex-dev/resend";
import type { AnyDataModel, GenericActionCtx } from "convex/server";
import { defineAuth } from "@robelest/convex-auth/server";
import {
  anonymous,
  device,
  email,
  google,
  passkey,
  password,
  connection,
  totp,
} from "@robelest/convex-auth/providers";

import { components } from "./_generated/api";
import { env } from "./_generated/server";
import { permissions } from "./roles";

function maybeGoogleProvider() {
  const clientId = env.AUTH_GOOGLE_ID;
  const clientSecret = env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }
  return google({ clientId, clientSecret });
}

const resend = new Resend(components.resend, {
  testMode: false,
});

/**
 * Context shape that {@link Resend.sendEmailManually} expects for its first
 * argument, derived from the method's own public signature so it tracks any
 * upstream change in `@convex-dev/resend`.
 */
type ResendSendCtx = Parameters<typeof resend.sendEmailManually>[0];

/**
 * Adapt the email provider's action `ctx` to the `ctx` resend wants.
 *
 * Resend types its `runMutation` after the *mutation* runtime, whose signature
 * permits a trailing `{ transactionLimits }` options argument. An action's
 * `runMutation` accepts no such option, so the two `runMutation` types are not
 * mutually assignable even though the action ctx is a fully capable caller at
 * runtime (resend never passes `transactionLimits`). The mismatch is therefore
 * an irreducible cross-package boundary; we isolate it to this single narrow,
 * member-level assertion rather than asserting the whole ctx.
 */
function asResendSendCtx(ctx: GenericActionCtx<AnyDataModel>): ResendSendCtx {
  return { runMutation: ctx.runMutation.bind(ctx) as ResendSendCtx["runMutation"] };
}

const emailProvider = email({
  from: env.AUTH_EMAIL ?? "My App <onboarding@resend.dev>",
  send: async (ctx, params) => {
    await resend.sendEmailManually(
      asResendSendCtx(ctx),
      {
        from: params.from,
        to: params.to,
        subject: params.subject,
      },
      async () => {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: params.from,
            to: params.to,
            subject: params.subject,
            html: params.html,
          }),
        });
        if (!res.ok) {
          throw new Error(`Email send failed: ${res.status}`);
        }
        const payload = (await res.json()) as { id?: string };
        return payload.id ?? "sent";
      },
    );
  },
});

const passwordEmailVerification = env.AUTH_PASSWORD_EMAIL_VERIFICATION === "true";
const passwordProvider = passwordEmailVerification
  ? password({ reset: emailProvider, verify: emailProvider })
  : password();

const googleProvider = maybeGoogleProvider();
const auth = defineAuth(components.auth, {
  providers: [
    connection(),
    ...(googleProvider ? [googleProvider] : []),
    passwordProvider,
    passkey(),
    totp({ issuer: "ConvexAuth Example" }),
    anonymous(),
    device({
      verificationUri: env.APP_URL ? `${env.APP_URL}/device` : "http://localhost:3001/device",
    }),
    emailProvider,
  ],
  permissions,
  oauth: {
    pages: { login: "/sign-in", consent: "/oauth/authorize" },
  },
});

export { auth };
export const { signIn, signOut, store } = auth;
