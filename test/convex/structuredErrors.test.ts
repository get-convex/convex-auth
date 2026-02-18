import { expect, test } from "vitest";
import {
  AuthErrorCode,
  legacyOnAuthError,
  defaultOnAuthError,
} from "@convex-dev/auth/server";

// --- AuthErrorCode vocabulary ---

test("AuthErrorCode has all expected codes", () => {
  expect(AuthErrorCode.INVALID_CREDENTIALS).toBe("INVALID_CREDENTIALS");
  expect(AuthErrorCode.ACCOUNT_NOT_FOUND).toBe("ACCOUNT_NOT_FOUND");
  expect(AuthErrorCode.INVALID_CODE).toBe("INVALID_CODE");
  expect(AuthErrorCode.EXPIRED_CODE).toBe("EXPIRED_CODE");
  expect(AuthErrorCode.INVALID_VERIFIER).toBe("INVALID_VERIFIER");
  expect(AuthErrorCode.ACCOUNT_DELETED).toBe("ACCOUNT_DELETED");
  expect(AuthErrorCode.PROVIDER_MISMATCH).toBe("PROVIDER_MISMATCH");
  expect(AuthErrorCode.RATE_LIMITED).toBe("RATE_LIMITED");
  expect(AuthErrorCode.INVALID_REFRESH_TOKEN).toBe("INVALID_REFRESH_TOKEN");
  expect(AuthErrorCode.EXPIRED_SESSION).toBe("EXPIRED_SESSION");
  expect(AuthErrorCode.OAUTH_FAILED).toBe("OAUTH_FAILED");
  expect(AuthErrorCode.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
});

// --- legacyOnAuthError ---

test("legacyOnAuthError throws with legacyMessage when non-null", () => {
  expect(() =>
    legacyOnAuthError({}, { legacyMessage: "InvalidSecret" }),
  ).toThrow("InvalidSecret");

  expect(() =>
    legacyOnAuthError({}, { legacyMessage: "Could not verify code" }),
  ).toThrow("Could not verify code");

  expect(() =>
    legacyOnAuthError({}, { legacyMessage: "TooManyFailedAttempts" }),
  ).toThrow("TooManyFailedAttempts");
});

test("legacyOnAuthError stays silent when legacyMessage is null", () => {
  expect(() =>
    legacyOnAuthError({}, { legacyMessage: null }),
  ).not.toThrow();
});

// --- defaultOnAuthError ---

test("defaultOnAuthError throws opaque Error for auth failures", () => {
  const authErrors: AuthErrorCode[] = [
    AuthErrorCode.INVALID_CREDENTIALS,
    AuthErrorCode.ACCOUNT_NOT_FOUND,
    AuthErrorCode.INVALID_CODE,
    AuthErrorCode.EXPIRED_CODE,
    AuthErrorCode.INVALID_VERIFIER,
    AuthErrorCode.ACCOUNT_DELETED,
    AuthErrorCode.PROVIDER_MISMATCH,
    AuthErrorCode.RATE_LIMITED,
    AuthErrorCode.OAUTH_FAILED,
    AuthErrorCode.INTERNAL_ERROR,
  ];

  for (const code of authErrors) {
    expect(() =>
      defaultOnAuthError({}, { error: code, legacyMessage: null }),
    ).toThrow(code);
  }
});

test("defaultOnAuthError throws plain Error, not ConvexError", () => {
  try {
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.INVALID_CREDENTIALS, legacyMessage: null },
    );
    expect.unreachable("should have thrown");
  } catch (e) {
    // Should be a plain Error, not a ConvexError
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("INVALID_CREDENTIALS");
    expect(e).not.toHaveProperty("data");
  }
});

test("defaultOnAuthError is silent for refresh token failures", () => {
  expect(() =>
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.INVALID_REFRESH_TOKEN, legacyMessage: null },
    ),
  ).not.toThrow();

  expect(() =>
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.EXPIRED_SESSION, legacyMessage: null },
    ),
  ).not.toThrow();
});

test("defaultOnAuthError ignores legacyMessage", () => {
  // Should throw based on error code, regardless of legacyMessage value
  expect(() =>
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.INVALID_CREDENTIALS, legacyMessage: "InvalidSecret" },
    ),
  ).toThrow("INVALID_CREDENTIALS");

  expect(() =>
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.RATE_LIMITED, legacyMessage: "TooManyFailedAttempts" },
    ),
  ).toThrow("RATE_LIMITED");
});
