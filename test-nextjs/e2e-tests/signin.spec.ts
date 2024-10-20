import { test, expect } from "@playwright/test";

// test("signin fails correctly", async ({ page }) => {
//   await page.goto("/");

//   await page.getByRole("link").getByText("Get Started").first().click();

//   await page
//     .getByLabel("Secret")
//     .fill(
//       "for the love of all mighty please don't set this as the secret value",
//     );

//   // Record the alert message
//   let message = "";
//   page.on("dialog", (dialog) => {
//     message = dialog.message();
//     dialog.accept();
//   });

//   await page.getByRole("button").getByText("Sign in with secret").click();

//   expect(message).toBe("Invalid secret");
// });
