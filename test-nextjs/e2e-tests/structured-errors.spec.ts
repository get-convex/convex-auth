import { test, expect } from "@playwright/test";

test("thrown ConvexError is preserved through Next.js proxy", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("link").getByText("Get Started").first().click();

  await page.waitForURL("/signin");

  await page.getByLabel("Secret").fill("test-structured-error");

  // Record the alert message
  let message = "";
  page.on("dialog", (dialog) => {
    message = dialog.message();
    void dialog.accept();
  });

  await page.getByRole("button").getByText("Sign in with secret").click();

  // handleError throws ConvexError for INVALID_CREDENTIALS;
  // the proxy preserves it so the client catches ConvexError with .data.code
  await expect.poll(async () => message).toBe("INVALID_CREDENTIALS");
});

test("returned error code is preserved through Next.js proxy", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("link").getByText("Get Started").first().click();

  await page.waitForURL("/signin");

  await page.getByLabel("Secret").fill("test-returned-error");

  let message = "";
  page.on("dialog", (dialog) => {
    message = dialog.message();
    void dialog.accept();
  });

  await page.getByRole("button").getByText("Sign in with secret").click();

  // handleError returns RATE_LIMITED (doesn't throw);
  // the proxy forwards it as result.error on the client
  await expect.poll(async () => message).toBe("RATE_LIMITED");
});
