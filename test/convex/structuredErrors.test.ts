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

test("defaultOnAuthError returns error codes for client consumption", () => {
  const passThrough: AuthErrorCode[] = [
    AuthErrorCode.INVALID_CREDENTIALS,
    AuthErrorCode.INVALID_CODE,
    AuthErrorCode.EXPIRED_CODE,
    AuthErrorCode.INVALID_VERIFIER,
    AuthErrorCode.PROVIDER_MISMATCH,
    AuthErrorCode.RATE_LIMITED,
    AuthErrorCode.OAUTH_FAILED,
    AuthErrorCode.INTERNAL_ERROR,
  ];

  for (const code of passThrough) {
    expect(
      defaultOnAuthError({}, { error: code, legacyMessage: null }),
    ).toBe(code);
  }
});

test("defaultOnAuthError maps ACCOUNT_NOT_FOUND to INVALID_CREDENTIALS", () => {
  expect(
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.ACCOUNT_NOT_FOUND, legacyMessage: null },
    ),
  ).toBe(AuthErrorCode.INVALID_CREDENTIALS);
});

test("defaultOnAuthError maps ACCOUNT_DELETED to INVALID_CREDENTIALS", () => {
  expect(
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.ACCOUNT_DELETED, legacyMessage: null },
    ),
  ).toBe(AuthErrorCode.INVALID_CREDENTIALS);
});

test("defaultOnAuthError returns void for refresh token failures", () => {
  expect(
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.INVALID_REFRESH_TOKEN, legacyMessage: null },
    ),
  ).toBeUndefined();

  expect(
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.EXPIRED_SESSION, legacyMessage: null },
    ),
  ).toBeUndefined();
});

test("defaultOnAuthError ignores legacyMessage", () => {
  expect(
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.INVALID_CREDENTIALS, legacyMessage: "InvalidSecret" },
    ),
  ).toBe(AuthErrorCode.INVALID_CREDENTIALS);

  expect(
    defaultOnAuthError(
      {},
      { error: AuthErrorCode.RATE_LIMITED, legacyMessage: "TooManyFailedAttempts" },
    ),
  ).toBe(AuthErrorCode.RATE_LIMITED);
});
