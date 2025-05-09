import { test, expect } from "@playwright/test";

test("signin fails correctly", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link").getByText("Get Started").first().click();

  await page.waitForURL("/signin");

  await page
    .getByLabel("Secret")
    .fill(
      "for the love of all mighty please don't set this as the secret value",
    );

  // Record the alert message
  let message = "";
  page.on("dialog", (dialog) => {
    message = dialog.message();
    void dialog.accept();
  });

  await page.getByRole("button").getByText("Sign in with secret").click();

  // Need to wait for the dialog to appear, it's async
  await expect.poll(async () => message).toBe("Invalid secret");
});
