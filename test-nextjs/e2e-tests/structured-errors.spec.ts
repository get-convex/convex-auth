import { test, expect } from "@playwright/test";

test("structured error code is preserved through Next.js proxy", async ({
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

  // The dialog should show the clean error code, not a JSON string or garbled message
  await expect.poll(async () => message).toBe("INVALID_CREDENTIALS");
});
