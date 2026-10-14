// The example with `CONVEX_EMAIL_SERVICE_URL` set, which switches auth.ts to
// the `convex` email sender. Vitest imports the modules again for each test
// file, so auth.ts reads the stubbed variable below.
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api";
import { registerCore } from "@convex-dev/auth/test";
import { registerPasswordProvider } from "@convex-dev/auth/components/password/test";
import {
  registerEmail,
  scheduledConvexEmails,
} from "@convex-dev/auth/components/email/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const IP = "203.0.113.7";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(await exportPKCS8(privateKey)));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [
        { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" },
      ],
    }),
  );
  vi.stubEnv("CONVEX_EMAIL_SERVICE_URL", "https://auth-emails.test");

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  registerEmail(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("signUp sends the validation link through the convex sender", async () => {
  const t = await setup();
  const result = await t
    .withRequestMetadata({ ip: IP })
    .mutation(api.auth.signUp, {
      email: "alice@example.com",
      password: "correct horse battery staple",
    });
  expect(result).toMatchObject({ success: true });

  expect(await scheduledConvexEmails(t)).toEqual([
    {
      to: "alice@example.com",
      appName: "My App",
      template: {
        kind: "validateEmail",
        link: expect.stringMatching(
          /^http:\/\/localhost:5173\/validate-email\?code=/,
        ),
        ttlMs: 60 * 60 * 1000,
      },
    },
  ]);
});
