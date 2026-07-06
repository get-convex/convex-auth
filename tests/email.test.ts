import { api } from "@convex/_generated/api";
import schema from "@convex/schema";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { convexTest } from "./convex/setup";
import { expectSignInSession, MOCK_EMAIL_ID, RESEND_API_URL } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("sign in with email", async () => {
  const t = convexTest(schema);

  let code;
  let capturedInit: any = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (typeof input === "string" && input === RESEND_API_URL) {
        capturedInit = init;

        code = init.body.match(/\?code=([^\s\\]+)/)?.[1];
        return new Response(JSON.stringify({ id: MOCK_EMAIL_ID }), {
          status: 200,
        });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  await t.action(api.auth.signIn, {
    provider: "email",
    params: { email: "tom@gmail.com" },
  });
  vi.unstubAllGlobals();

  expect(capturedInit).not.toBeNull();
  expect(capturedInit.headers.Authorization).toBe(`Bearer ${process.env.RESEND_API_KEY}`);
  expect(capturedInit.body).toBeTypeOf("string");
  expect(code).toBeTypeOf("string");

  if (typeof code !== "string") {
    throw new Error("Expected email sign-in code to be captured");
  }

  const tokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      params: { code },
    }),
  );

  expect(tokens).not.toBeNull();
});

test("redirectTo with email", async () => {
  const t = convexTest(schema);

  let capturedInit: any = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (typeof input === "string" && input === RESEND_API_URL) {
        capturedInit = init;
        return new Response(JSON.stringify({ id: MOCK_EMAIL_ID }), {
          status: 200,
        });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  await t.action(api.auth.signIn, {
    provider: "email",
    params: { email: "tom@gmail.com", redirectTo: "/dashboard" },
  });
  vi.unstubAllGlobals();

  expect(capturedInit).not.toBeNull();
  expect(capturedInit.headers.Authorization).toBe(`Bearer ${process.env.RESEND_API_KEY}`);
  expect(capturedInit.body).toBeTypeOf("string");

  const appUrl = process.env.APP_URL ?? "http://localhost:5173";
  const escapedAppUrl = appUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const code = capturedInit.body.match(
    new RegExp(`${escapedAppUrl}\\/dashboard\\?code=([^\\s]+)`),
  )?.[1];
  expect(code).toBeTypeOf("string");
});
