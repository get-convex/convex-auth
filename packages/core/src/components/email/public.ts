import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { FunctionHandle } from "convex/server";
import { Infer, v } from "convex/values";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { sha256Hex } from "../../lib/crypto";
import { generateRandomToken } from "./crypto";
import {
  normalizeEmail,
  validateEmailFormat,
  vValidationPurposeArg,
  vPurposeKind,
  startValidationUserError,
  completeValidationUserError,
  vEmailSenderConfig,
  type EmailSenderConfig,
  type PurposeKind,
} from "./validation";

// --- Configuration ---------------------------------------------------------

/** How long an add-email link stays valid. TODO: review this value. */
export const ADD_EMAIL_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long a password-reset link stays valid. OWASP ASVS v5 6.5.5 requires
 * at most 10 minutes for password-reset flows. TODO: review this value.
 */
export const PASSWORD_RESET_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Throttle for starting validation flows. Each flow sends an email, so the
// limits protect the destination mailbox from flooding and the sender's
// reputation from abuse:
// - per destination address, so an attacker cannot flood one mailbox;
// - per client IP, so one machine cannot spray many addresses.
// TODO: review these limits.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  startValidationPerEmail: { kind: "token bucket", rate: 5, period: HOUR },
  startValidationPerIp: { kind: "token bucket", rate: 20, period: HOUR },
});

// --- Internal helpers ------------------------------------------------------

/**
 * The client IP of the request, for rate limiting.
 *
 * Throws when the backend does not expose request metadata (`ctx.meta`
 * requires a Convex backend from July 2026 or later) or when the call did
 * not come from a request with an IP. There is no fallback: without an IP
 * the per-IP rate limit would not protect anything.
 */
async function getClientIp(ctx: MutationCtx): Promise<string> {
  // Old backends (and convex-test) have no `ctx.meta`.
  const meta = (ctx as Partial<MutationCtx>).meta;
  if (meta === undefined) {
    throw new Error(
      "The email component requires `ctx.meta` for IP rate limiting. " +
        "Upgrade your Convex backend to a version that supplies request " +
        "metadata to component functions.",
    );
  }
  const { ip } = await meta.getRequestMetadata();
  if (ip === null) {
    throw new Error(
      "The email component could not read the client IP for rate " +
        "limiting. Start validation flows from a client request, not from " +
        "a scheduled or cron function.",
    );
  }
  return ip;
}

function emailsByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"verifiedEmails">[]> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
}

function emailByNormalizedEmail(
  ctx: QueryCtx,
  normalizedEmail: string,
): Promise<Doc<"verifiedEmails"> | null> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_normalizedEmail", (q) =>
      q.eq("normalizedEmail", normalizedEmail),
    )
    .unique();
}

/** The plain-text body of a validation email. */
function validationEmailText(purpose: PurposeKind, link: string): string {
  // TODO: also offer a short code the user can type, with rate limiting on
  // attempts (a short code is guessable, unlike the 256-bit link code).
  if (purpose === "passwordReset") {
    return (
      "Open this link to reset your password:\n\n" +
      `${link}\n\n` +
      "The link stops working after 10 minutes, and works only in the " +
      "browser you started from.\n\n" +
      "If you did not request this email, you can ignore it."
    );
  }
  return (
    "Open this link to validate your email address:\n\n" +
    `${link}\n\n` +
    "The link stops working after 1 hour, and works only in the browser " +
    "you started from.\n\n" +
    "If you did not request this email, you can ignore it."
  );
}

/** The subject line of a validation email. */
function validationEmailSubject(purpose: PurposeKind): string {
  return purpose === "passwordReset"
    ? "Reset your password"
    : "Validate your email address";
}

/** Append the code to the landing URL, with `?` or `&` as needed. */
function buildLink(url: string, code: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}code=${encodeURIComponent(code)}`;
}

/** The `sendEmail` mutation of the `@convex-dev/resend` component. */
type SendEmailHandle = FunctionHandle<
  "mutation",
  {
    options: {
      apiKey: string;
      testMode: boolean;
      initialBackoffMs: number;
      retryAttempts: number;
    };
    from: string;
    to: string[];
    subject: string;
    text: string;
  },
  string
>;

async function sendValidationEmail(
  ctx: MutationCtx,
  sender: EmailSenderConfig,
  to: string,
  purpose: PurposeKind,
  link: string,
): Promise<void> {
  await ctx.runMutation(sender.sendEmailHandle as SendEmailHandle, {
    options: {
      apiKey: sender.apiKey,
      testMode: sender.testMode,
      initialBackoffMs: sender.initialBackoffMs,
      retryAttempts: sender.retryAttempts,
    },
    from: sender.from,
    to: [to],
    subject: validationEmailSubject(purpose),
    text: validationEmailText(purpose, link),
  });
}

// --- Public API: verified-email storage -------------------------------------

/**
 * Get the verified email addresses of a user.
 *
 * The function returns an empty array when the user has no verified email.
 */
export const getEmails = query({
  args: { userId: v.string() },
  returns: v.array(v.object({ email: v.string(), isPrimary: v.boolean() })),
  handler: async (
    ctx,
    { userId },
  ): Promise<{ email: string; isPrimary: boolean }[]> => {
    const rows = await emailsByUserId(ctx, userId);
    return rows.map((row) => ({ email: row.email, isPrimary: row.isPrimary }));
  },
});

/**
 * Find the user that a verified email address identifies.
 *
 * The lookup ignores the case and the Unicode normalization form of the
 * `email` argument. The `email` field of the result is the stored address,
 * with the case that the user gave, which can be different from the argument.
 * The function returns `null` when no user has verified this address.
 */
export const getUserIdByEmail = query({
  args: { email: v.string() },
  returns: v.union(
    v.object({ userId: v.string(), email: v.string() }),
    v.null(),
  ),
  handler: async (
    ctx,
    { email },
  ): Promise<{ userId: string; email: string } | null> => {
    const row = await emailByNormalizedEmail(ctx, normalizeEmail(email));
    return row === null ? null : { userId: row.userId, email: row.email };
  },
});

/**
 * Delete all data the component holds for a user: verified emails and
 * pending validations.
 *
 * Call this when the app deletes the user. The function is idempotent.
 */
export const deleteUser = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }): Promise<null> => {
    const rows = await emailsByUserId(ctx, userId);
    for (const row of rows) {
      await ctx.db.delete("verifiedEmails", row._id);
    }
    const validations = await ctx.db
      .query("pendingValidations")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const row of validations) {
      await ctx.db.delete("pendingValidations", row._id);
    }
    return null;
  },
});

// --- Public API: the validation flow ----------------------------------------

const checkStartValidationResult = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
);
type CheckStartValidationResult = Infer<typeof checkStartValidationResult>;

/**
 * Tell whether `startValidation` would be rate limited, without consuming
 * the limits.
 *
 * Callers that must do other work before `startValidation` (for example,
 * create the user) call this first and stop early on a limit, so the other
 * work is not committed when the flow cannot start. The check and the later
 * consumption run in one transaction when both happen in one mutation, so a
 * passing check cannot turn into a failing consumption.
 */
export const checkStartValidation = mutation({
  args: { email: v.string() },
  returns: checkStartValidationResult,
  handler: async (ctx, { email }): Promise<CheckStartValidationResult> => {
    const key = normalizeEmail(email);
    const ip = await getClientIp(ctx);
    const perEmail = await rateLimiter.check(ctx, "startValidationPerEmail", {
      key,
    });
    const perIp = await rateLimiter.check(ctx, "startValidationPerIp", {
      key: ip,
    });
    if (!perEmail.ok || !perIp.ok) {
      return {
        ok: false,
        retryAfterMs: Math.max(
          perEmail.ok ? 0 : perEmail.retryAfter,
          perIp.ok ? 0 : perIp.retryAfter,
        ),
      };
    }
    return { ok: true };
  },
});

const startValidationResult = v.union(
  v.object({
    success: v.literal(true),
    // The secret the client must keep (in its local storage) and present
    // again at completion. It never travels in the email.
    secret: v.string(),
  }),
  v.object({ success: v.literal(false), userError: startValidationUserError }),
);
type StartValidationResult = Infer<typeof startValidationResult>;

/**
 * Start a validation flow: check the address, consume the rate limits,
 * store the hashed code + secret, and send the email.
 *
 * The emailed link carries the code; the returned secret stays in the
 * starting browser. Completion requires both, so a person who only sees the
 * email (or only sees the database) cannot complete the flow.
 *
 * `url` is the landing page the link points at; the code is appended as the
 * `code` query parameter. The caller controls this value — do not pass
 * client-supplied URLs, or the email becomes a phishing vector from a
 * legitimate sender.
 */
export const startValidation = mutation({
  args: {
    email: v.string(),
    purpose: vValidationPurposeArg,
    url: v.string(),
    emailSender: vEmailSenderConfig,
  },
  returns: startValidationResult,
  handler: async (ctx, args): Promise<StartValidationResult> => {
    const formatError = validateEmailFormat(args.email);
    if (formatError !== null) {
      return { success: false, userError: formatError };
    }
    // `email` keeps the case the user gave: the link goes to that address and
    // a completion records it. `normalizedEmail` is the lookup key.
    const email = args.email;
    const normalizedEmail = normalizeEmail(email);

    // Consume both rate limits. A failure after `checkStartValidation`
    // passed in the same mutation is unexpected (same transaction), so
    // callers that pre-checked treat the `RATE_LIMITED` arm as unreachable.
    const ip = await getClientIp(ctx);
    const perEmail = await rateLimiter.limit(ctx, "startValidationPerEmail", {
      key: normalizedEmail,
    });
    if (!perEmail.ok) {
      return {
        success: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: perEmail.retryAfter },
      };
    }
    const perIp = await rateLimiter.limit(ctx, "startValidationPerIp", {
      key: ip,
    });
    if (!perIp.ok) {
      return {
        success: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: perIp.retryAfter },
      };
    }

    // Purpose-specific checks resolve the user the flow is for.
    const existing = await emailByNormalizedEmail(ctx, normalizedEmail);
    let userId: string;
    if (args.purpose.kind === "passwordReset") {
      if (existing === null) {
        return { success: false, userError: { error: "EMAIL_NOT_FOUND" } };
      }
      userId = existing.userId;
    } else {
      if (existing !== null) {
        return { success: false, userError: { error: "EMAIL_TAKEN" } };
      }
      userId = args.purpose.userId;
    }

    const code = generateRandomToken();
    const secret = generateRandomToken();
    const ttl =
      args.purpose.kind === "passwordReset"
        ? PASSWORD_RESET_TTL_MS
        : ADD_EMAIL_TTL_MS;
    await ctx.db.insert("pendingValidations", {
      email,
      normalizedEmail,
      userId,
      purpose: { kind: args.purpose.kind },
      codeHash: await sha256Hex(code),
      secretHash: await sha256Hex(secret),
      expiresAt: Date.now() + ttl,
    });

    await sendValidationEmail(
      ctx,
      args.emailSender,
      email,
      args.purpose.kind,
      buildLink(args.url, code),
    );

    return { success: true, secret };
  },
});

const completeValidationResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    email: v.string(),
    // For `setEmail`: the address that was primary before this completion
    // replaced it, or `null` when there was none. Callers use it to notify
    // the old address.
    previousPrimaryEmail: v.union(v.string(), v.null()),
  }),
  v.object({
    success: v.literal(false),
    userError: completeValidationUserError,
  }),
);
type CompleteValidationResult = Infer<typeof completeValidationResult>;

/**
 * Complete a validation flow with the code from the link and the secret
 * from the starting browser.
 *
 * The claim is one-shot: the row is deleted as soon as the code matches,
 * even when the secret is wrong or the link has expired, so a link can
 * never be replayed. An unknown code, a wrong secret, an expired link and a
 * purpose mismatch all return the same `INVALID_LINK` error.
 *
 * For `addEmail` and `setEmail`, completion records the address (see
 * `vValidationPurposeArg` for the primary rules); `setEmail` also returns
 * the previous primary address when it replaced one. For `passwordReset`,
 * completion writes nothing and returns the `userId` as the ownership
 * proof.
 */
export const completeValidation = mutation({
  args: {
    code: v.string(),
    secret: v.string(),
    purpose: vPurposeKind,
  },
  returns: completeValidationResult,
  handler: async (ctx, args): Promise<CompleteValidationResult> => {
    const codeHash = await sha256Hex(args.code);
    const row = await ctx.db
      .query("pendingValidations")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (row === null) {
      return { success: false, userError: { error: "INVALID_LINK" } };
    }
    // One-shot claim: delete before any check, so a raced or replayed
    // completion finds nothing.
    await ctx.db.delete("pendingValidations", row._id);

    if (
      row.secretHash !== (await sha256Hex(args.secret)) ||
      row.expiresAt < Date.now() ||
      row.purpose.kind !== args.purpose
    ) {
      return { success: false, userError: { error: "INVALID_LINK" } };
    }

    if (row.purpose.kind === "passwordReset") {
      // The proof is only valid while the address is still verified on the
      // same account.
      const verified = await emailByNormalizedEmail(ctx, row.normalizedEmail);
      if (verified === null || verified.userId !== row.userId) {
        return { success: false, userError: { error: "INVALID_LINK" } };
      }
      return {
        success: true,
        userId: row.userId,
        email: row.email,
        previousPrimaryEmail: null,
      };
    }

    // addEmail and setEmail: the address must still be free.
    const taken = await emailByNormalizedEmail(ctx, row.normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: { error: "EMAIL_TAKEN" } };
    }

    let previousPrimaryEmail: string | null = null;
    let isPrimary: boolean;
    if (row.purpose.kind === "setEmail") {
      // Replace the old primary address. For a first email (sign-up) there
      // is nothing to replace; for a change-email flow the old address is
      // removed from the account.
      const oldPrimary = await ctx.db
        .query("verifiedEmails")
        .withIndex("by_userId_isPrimary", (q) =>
          q.eq("userId", row.userId).eq("isPrimary", true),
        )
        .unique();
      if (oldPrimary !== null) {
        previousPrimaryEmail = oldPrimary.email;
        await ctx.db.delete("verifiedEmails", oldPrimary._id);
      }
      isPrimary = true;
    } else {
      // The first address of a user always becomes primary.
      isPrimary = (await emailsByUserId(ctx, row.userId)).length === 0;
    }
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      userId: row.userId,
      isPrimary,
    });

    // The address is now verified, so every other pending validation for it
    // can no longer succeed. Delete them instead of leaving them to fail.
    const siblings = await ctx.db
      .query("pendingValidations")
      .withIndex("by_normalizedEmail", (q) =>
        q.eq("normalizedEmail", row.normalizedEmail),
      )
      .collect();
    for (const sibling of siblings) {
      await ctx.db.delete("pendingValidations", sibling._id);
    }

    return {
      success: true,
      userId: row.userId,
      email: row.email,
      previousPrimaryEmail,
    };
  },
});

const validationStatus = v.union(
  v.object({
    status: v.literal("pending"),
    purpose: vPurposeKind,
    email: v.string(),
  }),
  v.object({ status: v.literal("invalid") }),
);
type ValidationStatus = Infer<typeof validationStatus>;

/**
 * Report the state of a validation flow without claiming it.
 *
 * Landing pages call this to show what the link will do (and to which
 * address) before the user confirms. The checks are the same as
 * `completeValidation`, including the secret, so a person who only has the
 * link learns nothing.
 */
export const getValidationStatus = query({
  args: { code: v.string(), secret: v.string() },
  returns: validationStatus,
  handler: async (ctx, args): Promise<ValidationStatus> => {
    const codeHash = await sha256Hex(args.code);
    const row = await ctx.db
      .query("pendingValidations")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (
      row === null ||
      row.secretHash !== (await sha256Hex(args.secret)) ||
      row.expiresAt < Date.now()
    ) {
      return { status: "invalid" };
    }
    return { status: "pending", purpose: row.purpose.kind, email: row.email };
  },
});
