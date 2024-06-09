import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { CONVEX_SITE_URL, JWKS, JWT_PRIVATE_KEY } from "./test.helpers";

test("sign up and sign in with oauth", async () => {
  setupEnv();
  const t = convexTest(schema);

  const { redirect } = await t.action(api.auth.signIn, {
    provider: "github",
    params: {},
  });
  expect(redirect).toEqual(
    process.env.CONVEX_SITE_URL + `/api/auth/signin/github`,
  );

  const verifier = "123456";
  const url = new URL(redirect!).pathname + `?code=${verifier}`;
  const response = await t.fetch(url);

  const redirectedTo = response.headers.get("Location");
  const cookies = response.headers.get("Set-Cookie");

  expect(redirectedTo).not.toBeNull();
  expect(cookies).not.toBeNull();

  const redirectedToParams = new URL(redirectedTo!).searchParams;

  const callbackUrl = redirectedToParams.get("redirect_uri");
  const state = redirectedToParams.get("state");
  expect(callbackUrl).not.toBeNull();
  expect(state).not.toBeNull();

  const issuedOAuthCode = "mightygithub";
  const issuedAccessToken = "veryfancyaccesstoken";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (
        input instanceof Request &&
        input.url === "https://github.com/login/oauth/access_token"
      ) {
        const args = await input.formData();
        expect(args.get("client_id")).toBe(process.env.AUTH_GITHUB_ID);
        expect(args.get("client_secret")).toBe(process.env.AUTH_GITHUB_SECRET);
        expect(args.get("code")).toBe(issuedOAuthCode);
        return new Response(
          JSON.stringify({ access_token: issuedAccessToken }),
          { status: 200 },
        );
      } else if (
        input instanceof URL &&
        input.href === "https://api.github.com/user"
      ) {
        expect(init.headers.Authorization).toBe(`Bearer ${issuedAccessToken}`);
        return new Response(
          JSON.stringify({
            email: "sara@gmail.com",
            name: "Sara",
            id: "someGitHubId",
          }),
          { status: 200 },
        );
      }

      throw new Error("Unexpected fetch");
    }),
  );

  const callbackResponse = await t.fetch(
    `${new URL(callbackUrl!).pathname}?code=${issuedOAuthCode}&state=${state}`,
    { headers: { Cookie: cookies! } },
  );

  vi.unstubAllGlobals();
  const finalRedirectedTo = callbackResponse.headers.get("Location");

  expect(finalRedirectedTo).not.toBeNull();
  const code = new URL(finalRedirectedTo!).searchParams.get("code");

  const tokens = await t.action("auth:verifyCode" as any, {
    params: { code },
    verifier,
  });

  expect(tokens).not.toBeNull();

  await t.run(async (ctx) => {
    const verificationCodes = await ctx.db.query("verificationCodes").collect();
    expect(verificationCodes).toHaveLength(0);
    const verifiers = await ctx.db.query("verifiers").collect();
    expect(verifiers).toHaveLength(0);
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_GITHUB_ID = "githubClientId";
  process.env.AUTH_GITHUB_SECRET = "githubClientSecret";
}
