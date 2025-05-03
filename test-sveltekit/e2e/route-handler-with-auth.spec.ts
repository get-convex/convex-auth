import { test, expect, Page } from "@playwright/test";

test("route handler returns 403 when not authenticated", async ({ page }) => {
    const response = await page.goto("/api/");

    expect(response).not.toBeNull();
    expect(response?.status()).toBe(403);
});

test("route handler returns 200 when authenticated", async ({ page }) => {
    await signIn(page);


    const response = await page.goto("/api/");

    expect(response).not.toBeNull();
    expect(response?.status()).toBe(200);

    await signOut(page);
});

async function signIn(page: Page) {
    await page.goto("/signin");  
    await page.getByLabel("Secret").fill(process.env.AUTH_E2E_TEST_SECRET!);
    await page.getByRole("button").getByText("Sign in with secret").click();
    await page.waitForURL("/product");
}

async function signOut(page: Page) {
    await page.goto("/product");
    await page.locator("#user-menu-trigger").click();
    await page.getByRole("button").getByText("Sign out").click();
}