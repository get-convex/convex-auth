import { describe, expect, test } from "vitest";
import {
  convexEmailSender,
  scheduledConvexEmails,
} from "../../testing/authEmailsService.ts";
import { api } from "./_generated/api.ts";
import { ADD_EMAIL_TTL_MS } from "./helpers.ts";
import { seedEmail, setupClient } from "../emailTestSetup.ts";

const URL = "https://app.example/landing";

describe("the convex email sender", () => {
  test("schedules a validateEmail email for a sign-up", async () => {
    const t = setupClient();
    const result = await t.mutation(api.challenge.signUp.start, {
      email: "alice@example.com",
      userId: "user1",
      url: URL,
      emailSender: convexEmailSender({ appName: "My App" }),
    });
    expect(result).toMatchObject({ success: true });

    expect(await scheduledConvexEmails(t, null)).toEqual([
      {
        to: "alice@example.com",
        appName: "My App",
        template: {
          kind: "validateEmail",
          link: expect.stringMatching(
            /^https:\/\/app\.example\/landing\?code=[\w-]{43}$/,
          ),
          ttlMs: ADD_EMAIL_TTL_MS,
        },
      },
    ]);
  });

  test("sends a custom challenge with its convexTemplate", async () => {
    const t = setupClient();
    await seedEmail(t, "user1", "alice@example.com", true);
    await t.mutation(api.challenge.custom.start, {
      email: "alice@example.com",
      purpose: "test/recovery",
      expectedUserId: null,
      url: URL,
      emailSender: convexEmailSender(),
      subject: "Reset your password",
      intro: "Open this link to reset your password:",
      convexTemplate: "resetPassword",
      ttlMs: 10 * 60 * 1000,
    });

    const [email] = await scheduledConvexEmails(t, null);
    expect(email).toMatchObject({
      to: "alice@example.com",
      template: { kind: "resetPassword", ttlMs: 10 * 60 * 1000 },
    });
    expect(email.appName).toBeUndefined();
  });

  test("rejects a custom challenge without a convexTemplate", async () => {
    const t = setupClient();
    await seedEmail(t, "user1", "alice@example.com", true);
    await expect(
      t.mutation(api.challenge.custom.start, {
        email: "alice@example.com",
        purpose: "test/magicLink",
        expectedUserId: null,
        url: URL,
        emailSender: convexEmailSender(),
        subject: "Sign in",
        intro: "Open this link to sign in:",
      }),
    ).rejects.toThrow(/sends only its own templates/);
    // The throw rolls the challenge back with the email.
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
  });

  test("sendNotification schedules the notification", async () => {
    const t = setupClient();
    await t.mutation(api.authEmailsService.sendNotification, {
      emailSender: convexEmailSender({ appName: "My App" }),
      to: "alice@example.com",
      template: { kind: "emailChanged", newEmail: "alice@new.example" },
    });
    expect(await scheduledConvexEmails(t, null)).toEqual([
      {
        to: "alice@example.com",
        appName: "My App",
        template: { kind: "emailChanged", newEmail: "alice@new.example" },
      },
    ]);
  });
});
