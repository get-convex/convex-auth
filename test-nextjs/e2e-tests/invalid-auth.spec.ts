import { test } from "@playwright/test";
import { SignJWT } from "jose";

test("invalid auth cookie redirects to signin page", async ({
  page,
  context,
}) => {
  // Create a fake JWT that's otherwise valid.
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
  
  // Set cookies for the fake JWT and a junk refresh token too.
  await context.addCookies([
    { name: "__convexAuthJWT", value: jwt, path: "/", domain: "127.0.0.1" },
    {
      name: "__convexAuthRefreshToken",
      value: "foobar",
      path: "/",
      domain: "127.0.0.1",
    },
  ]);

  // An attempt to go to a protected route should redirect to sign-in.
  await page.goto("/product");
  await page.waitForURL("/signin");
});
