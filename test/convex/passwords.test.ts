import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  mockResendOTP,
} from "./test.helpers";

test("sign up with password", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  expect(tokens).not.toBeNull();

  const { tokens: tokens2 } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signIn" },
  });

  expect(tokens2).not.toBeNull();

  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "sarah@gmail.com", password: "wrong", flow: "signIn" },
    });
  }).rejects.toThrow("InvalidSecret");

  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "sarah@gmail.com" }]);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toMatchObject([
      { provider: "password", providerAccountId: "sarah@gmail.com" },
    ]);
    const sessions = await ctx.db.query("authSessions").collect();
    expect(sessions).toHaveLength(2);
  });

  // Sign out from each session

  const claims = decodeJwt(tokens!.token);
  await t.withIdentity({ subject: claims.sub }).action(api.auth.signOut);

  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("authSessions").collect();
    expect(sessions).toHaveLength(1);
  });

  const claims2 = decodeJwt(tokens2!.token);
  await t.withIdentity({ subject: claims2.sub }).action(api.auth.signOut);

  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("authSessions").collect();
    expect(sessions).toHaveLength(0);
  });
});

test("sign up with password and verify email", async () => {
  setupEnv();
  const t = convexTest(schema);

  const {
    code,
    result: { tokens },
  } = await mockResendOTP(
    async () =>
      await t.action(api.auth.signIn, {
        provider: "password-code",
        params: {
          email: "sarah@gmail.com",
          password: "44448888",
          flow: "signUp",
        },
      }),
  );

  // Not signed in because we sent an email
  expect(tokens).toBeNull();

  // Finish email verification with code
  const { tokens: validTokens } = await t.action(api.auth.signIn, {
    provider: "password-code",
    params: {
      email: "sarah@gmail.com",
      flow: "email-verification",
      code,
    },
  });

  expect(validTokens).not.toBeNull();

  // Now we can sign-in just with a password
  const { tokens: validTokens2 } = await t.action(api.auth.signIn, {
    provider: "password-code",
    params: {
      email: "sarah@gmail.com",
      flow: "signIn",
      password: "44448888",
    },
  });

  expect(validTokens2).not.toBeNull();
});

test("password reset flow", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up
  await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: {
      email: "sarah@gmail.com",
      password: "44448888",
      flow: "signUp",
    },
  });

  // Request password reset
  const { code } = await mockResendOTP(async () =>
    await t.action(api.auth.signIn, {
      provider: "password-with-reset",
      params: { email: "sarah@gmail.com", flow: "reset" },
    }),
  );

  // Complete reset with new password
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: {
      email: "sarah@gmail.com",
      code,
      newPassword: "99991111",
      flow: "reset-verification",
    },
  });

  expect(tokens).not.toBeNull();

  // Old password no longer works
  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password-with-reset",
      params: {
        email: "sarah@gmail.com",
        password: "44448888",
        flow: "signIn",
      },
    });
  }).rejects.toThrow("InvalidSecret");

  // New password works
  const { tokens: tokens2 } = await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: {
      email: "sarah@gmail.com",
      password: "99991111",
      flow: "signIn",
    },
  });

  expect(tokens2).not.toBeNull();
});

test("password reset code cannot be used for a different account", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up two users
  await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: {
      email: "attacker@gmail.com",
      password: "44448888",
      flow: "signUp",
    },
  });

  await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: {
      email: "victim@gmail.com",
      password: "secretpass1",
      flow: "signUp",
    },
  });

  // Attacker requests reset code for their own account
  const { code } = await mockResendOTP(async () =>
    await t.action(api.auth.signIn, {
      provider: "password-with-reset",
      params: { email: "attacker@gmail.com", flow: "reset" },
    }),
  );

  // Attacker tries to use their code with victim's email
  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password-with-reset",
      params: {
        email: "victim@gmail.com",
        code,
        newPassword: "hacked1234",
        flow: "reset-verification",
      },
    });
  }).rejects.toThrow();

  // Victim's password is unchanged
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: {
      email: "victim@gmail.com",
      password: "secretpass1",
      flow: "signIn",
    },
  });

  expect(tokens).not.toBeNull();
});

test("password reset code cannot be used for a different account (raw EmailConfig)", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up two users
  await t.action(api.auth.signIn, {
    provider: "password-raw-reset",
    params: {
      email: "attacker@gmail.com",
      password: "44448888",
      flow: "signUp",
    },
  });

  await t.action(api.auth.signIn, {
    provider: "password-raw-reset",
    params: {
      email: "victim@gmail.com",
      password: "secretpass1",
      flow: "signUp",
    },
  });

  // Attacker requests reset code for their own account
  const { code } = await mockResendOTP(async () =>
    await t.action(api.auth.signIn, {
      provider: "password-raw-reset",
      params: { email: "attacker@gmail.com", flow: "reset" },
    }),
  );

  // Attacker tries to use their code with victim's email.
  // Without the fix, this succeeds because the raw EmailConfig
  // has no authorize function to check the email mismatch.
  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password-raw-reset",
      params: {
        email: "victim@gmail.com",
        code,
        newPassword: "hacked1234",
        flow: "reset-verification",
      },
    });
  }).rejects.toThrow();

  // Victim's password is unchanged
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password-raw-reset",
    params: {
      email: "victim@gmail.com",
      password: "secretpass1",
      flow: "signIn",
    },
  });

  expect(tokens).not.toBeNull();
});

test("sign in with different email casing", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up with mixed case
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      email: "Sarah@Gmail.COM",
      password: "44448888",
      flow: "signUp",
    },
  });
  expect(tokens).not.toBeNull();

  // Sign in with lowercase should succeed
  const { tokens: tokens2 } = await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      email: "sarah@gmail.com",
      password: "44448888",
      flow: "signIn",
    },
  });
  expect(tokens2).not.toBeNull();

  // Verify only one user and one account exist, both normalized
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "sarah@gmail.com" }]);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toMatchObject([
      { provider: "password", providerAccountId: "sarah@gmail.com" },
    ]);
  });
});

test("duplicate sign up with different email casing reuses existing account", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up with mixed case
  await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      email: "Sarah@Gmail.COM",
      password: "44448888",
      flow: "signUp",
    },
  });

  // Sign up again with lowercase — should not create a second account
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      email: "sarah@gmail.com",
      password: "44448888",
      flow: "signUp",
    },
  });
  expect(tokens).not.toBeNull();

  // Verify still only one user and one account
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toHaveLength(1);
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
