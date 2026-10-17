import { BrowserContext, expect, test } from "@playwright/test";
import { SignJWT } from "jose";

test("invalid auth cookie redirects to signin page", async ({
  page,
  context,
}) => {
  await addFakeAuthCookies(
    context,
    cookieNameSuffix(process.env.NEXT_PUBLIC_CONVEX_URL!),
  );

  // An attempt to go to a protected route should redirect to sign-in.
  await page.goto("/product");
  await page.waitForURL("/signin");
});

test("auth cookies of other apps on the same host are ignored and kept", async ({
  page,
  context,
}) => {
  await page.goto("/signin");
  await page.getByLabel("Secret").fill(process.env.AUTH_E2E_TEST_SECRET!);
  await page.getByRole("button").getByText("Sign in with secret").click();
  await page.waitForURL("/product");

  // Cookies are shared across ports, so apps running on other ports of this
  // host write their auth cookies into the same jar: here, one using another
  // Convex deployment, and one on a version of Convex Auth that didn't
  // namespace its cookie names on localhost.
  const otherAppSuffixes = [cookieNameSuffix("http://127.0.0.1:3299"), ""];
  for (const suffix of otherAppSuffixes) {
    await addFakeAuthCookies(context, suffix);
  }

  // This app stays signed in.
  await page.goto("/product");
  await expect(page.getByRole("button", { name: "user menu" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/product");

  // And it leaves the other apps' cookies alone.
  const cookieNames = (await context.cookies()).map(({ name }) => name);
  for (const suffix of otherAppSuffixes) {
    expect(cookieNames).toContain(`__convexAuthJWT${suffix}`);
    expect(cookieNames).toContain(`__convexAuthRefreshToken${suffix}`);
  }
});

// On localhost, Convex Auth suffixes its cookie names with the letters and
// digits of the Convex URL.
function cookieNameSuffix(convexUrl: string) {
  return "_" + convexUrl.replace(/[^a-zA-Z0-9]/g, "");
}

// Sets a JWT that's otherwise valid but wasn't issued by this app's
// deployment, and a junk refresh token.
async function addFakeAuthCookies(context: BrowserContext, suffix: string) {
  const expirationTime = new Date(
    Date.now() + 12 * 60 * 60 * 1000, // 12 hours in the future
  );
  const jwt = await new SignJWT({
    sub: "blahblahblah",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("https://example.com")
    .setAudience("convex")
    .setExpirationTime(expirationTime)
    .sign(new TextEncoder().encode(""));

  await context.addCookies([
    {
      name: `__convexAuthJWT${suffix}`,
      value: jwt,
      path: "/",
      domain: "127.0.0.1",
    },
    {
      name: `__convexAuthRefreshToken${suffix}`,
      value: "foobar",
      path: "/",
      domain: "127.0.0.1",
    },
  ]);
}
