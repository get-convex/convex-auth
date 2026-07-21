import { redactCreateVerificationCodeArgsForLog } from "@robelest/convex-auth/server/mutations/code";
import { redactUserOAuthArgsForLog } from "@robelest/convex-auth/server/mutations/oauth";
import { expect, test } from "vite-plus/test";

test("DEBUG log redaction hides the plaintext verification code", () => {
  const code = "SECRETCODE1234567890ABCDEFGHIJKL"; // 32-char plaintext OTP/code
  const redacted = redactCreateVerificationCodeArgsForLog({
    provider: "resend-otp",
    email: "user@example.com",
    code,
    expirationTime: 1_700_000_000_000,
    allowExtraProviders: false,
  });

  // The plaintext code must never survive into a log-bound payload.
  expect(redacted.code).not.toBe(code);
  expect(JSON.stringify(redacted)).not.toContain(code);
  // Non-secret fields stay intact so DEBUG logs remain useful.
  expect(redacted.provider).toBe("resend-otp");
  expect(redacted.email).toBe("user@example.com");
});

test("DEBUG log redaction hides the OAuth state signature", () => {
  const signature = "sig_0123456789abcdef0123456789abcdef0123456789abcdef";
  const redacted = redactUserOAuthArgsForLog({
    provider: "google",
    providerAccountId: "acct-123",
    profile: { email: "user@example.com" },
    signature,
  });

  // The OAuth signature must never survive into a log-bound payload.
  expect(redacted.signature).not.toBe(signature);
  expect(JSON.stringify(redacted)).not.toContain(signature);
  // Non-secret fields stay intact so DEBUG logs remain useful.
  expect(redacted.provider).toBe("google");
  expect(redacted.providerAccountId).toBe("acct-123");
});
