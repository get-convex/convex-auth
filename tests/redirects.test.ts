import { redirectAbsoluteUrl } from "@robelest/convex-auth/server/redirects";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

const APP_URL = "http://localhost:5173";

let priorAppUrl: string | undefined;

beforeEach(() => {
  priorAppUrl = process.env.APP_URL;
  process.env.APP_URL = APP_URL;
});

afterEach(() => {
  if (priorAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = priorAppUrl;
});

const resolve = (redirectTo: unknown) =>
  redirectAbsoluteUrl(null as never, null as never, { redirectTo });

test("relative redirectTo resolves against APP_URL", async () => {
  expect(await resolve("/dashboard")).toBe(`${APP_URL}/dashboard`);
  expect(await resolve("?next=1")).toBe(`${APP_URL}?next=1`);
});

test("absolute redirectTo on the APP_URL origin is allowed", async () => {
  expect(await resolve(`${APP_URL}/welcome`)).toBe(`${APP_URL}/welcome`);
});

test("absolute redirectTo on an unallowlisted origin falls back to APP_URL", async () => {
  expect(await resolve("https://evil.com/steal")).toBe(APP_URL);
  // Subdomain-confusion must not pass an origin check.
  expect(await resolve("https://localhost:5173.evil.com/x")).toBe(APP_URL);
});

test("absolute redirectTo on a staging origin falls back to APP_URL", async () => {
  expect(await resolve("https://staging.example.com/app")).toBe(APP_URL);
  expect(await resolve("http://localhost:3000/cb")).toBe(APP_URL);
});

test("native deep-link redirectTo falls back to APP_URL", async () => {
  expect(await resolve("demoexpo://auth?code=abc")).toBe(APP_URL);
  expect(await resolve("demoexpo://auth.evil?code=abc")).toBe(APP_URL);
  expect(await resolve("demoexpo://authevil/cb")).toBe(APP_URL);
});

test("omitted redirectTo falls back to APP_URL", async () => {
  expect(await resolve(undefined)).toBe(APP_URL);
});
