import { test } from "@playwright/test";

test("signout works", async ({ page }) => {
  await page.goto("/signin");

  // await page.getByRole("link").getByText("Get Started").first().click();

  await page.getByLabel("Secret").fill(process.env.AUTH_E2E_TEST_SECRET!);

  await page.getByRole("button").getByText("Sign in with secret").click();

  await page.getByRole("button", { name: "user menu" }).click();

  await page.getByRole("menuitem").getByText("Sign out").click();
});
