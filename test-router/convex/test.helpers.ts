import { load as cheerio } from "cheerio";
import { TestConvexForDataModel } from "convex-test";
import { expect, vi } from "vitest";
import { api } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";

export const CONVEX_SITE_URL = "https://test-123.convex.site";
export const JWT_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY----- MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCetOSp/q0BMvEi lrJkJIcFH9Rbwvfcsexj8BPjnZ4Z28phl4jinenObC0VqcsLeBxLgVDGxVooOnVe njvCTMLJ3p//0SIdHHbaZ6xIml8aRogXDopdvE8+FvabC+xcCQAZ6ScdSgo6Vfff 94KqmmoOW0x7Q56lIUB+68S0NxGEYT7xlthgf4OogkDunt7EjXUXIIoZmu+qxceR C3OKDWFSOmBX3ThRNlKTVY4iSeVtrMDojhJdS4LRySW0wXh3ASnycI7E1yppAK8Z RfGeDSRXzlRmHL69qT4BZ1GMc0P3tB6wTnETQkvVCm9MNCGDxz/i4ukwRQ6ob1V/ etHlDoLTAgMBAAECggEAJuzjMLagJC0ka4Fem6VB4IXgBemZ9W1GN3TIzAj6oAkC aFFMZ5inodNyc1/DxzpcZkB/WWFKLZe49c4FhjBhjjWmNI5Muasjk4nd/aivLrih 5FXSpg7ruKTVM04HWMN0XOaMi2h/fbNcKniAeeuJm5/U8F6zaHjxYq/c/P6Ms1Tr rjC5MF9AtdiCKPMcuwILESUP1v0KD+dUIeg3dhZjs4txeYBBZTaAy7c+/wmgjw0Y NeYZw30yoaMNhLTw8NE5g3xC65V6+jggMA/RQjuwBsZB580/fMAo9l9VIGzYZrjc Smca/FdSV10Bxx8AaPU2z1MLqoCCsTMkrCTxpjXugQKBgQDSTKmCe97IkocO5hkj +I7//xjxsIBPuSObGqjtNX7JRmRJomVrXDWOk9jYa8V9rFeJ/AaI1q1UgxuiVLJ3 nkDAGYP5xqOHnLWuam4uYKmYmHcGAfSFpqbGpYZt8bHFPbg8krcuzUuTiqwtKcGK zhmxUUfDEK5NmzukHquEEbhAcwKBgQDBMgctjNW3Z8JvElg3oCcBMeRZwWrgdl+R s9K4TWR88M6WS7CEFinKrv6oTGfvd/tOYjAz2UKiZaYKj9SPKxaR19AZaDN3vOwj jwWcB0GOELhZutd831Y2JeIr0YLT4Ce6cFqOslqA40V9mfpypzDjo4Jyg2mRZ5IT DMG0yW/8IQKBgFFxuTA8ktIw1Tdy64efypngDKQFjBvUArMeBxAe6KRAq7RMvWRv yJoYLiHa0xhRt3FL9qfmJCiXwgsDLD7hPghnmVIRmOF7Um1i8JrreqMLYQUlmrJs ESjbkA1iTkuqFID4/RKWFU/lo7q18iu0mASxCs7D1g1eMiHkct5qEmZ7AoGAAUL+ YQHGc4gt8OPBx7s4Bf35a8yjkguz3BO8kI+Q1HAOKVUdNf+fDj/OUfMNyraR4ZUq k2wbz0uypecCkFzLrPAn38Kac3G8aQ8KDlbNysu5KHzb42jh+0CMFZUssY2JNOJ+ 9OedR7I0Rfm3dQA6hYIP3AeXrOdsQMuYiEG4hYECgYAzdP7iNkPaWnCT8DA6mbR1 y9NeMrfXleU9NYxoab4QR7exlwdvARL589qwznKmHdtLXIHT0LEmbDKoXuESmvnb ckkLxTSwqLtYSdXKm1ioup0OAhEtnZzlc/mE1xYSGKSADJOugs7gqzJdIUu4Xa5h IFjPu9rUh/4Gb1S83Uv75A== -----END PRIVATE KEY-----";
export const JWKS =
  '{"keys":[{"use":"sig","kty":"RSA","n":"nrTkqf6tATLxIpayZCSHBR_UW8L33LHsY_AT452eGdvKYZeI4p3pzmwtFanLC3gcS4FQxsVaKDp1Xp47wkzCyd6f_9EiHRx22mesSJpfGkaIFw6KXbxPPhb2mwvsXAkAGeknHUoKOlX33_eCqppqDltMe0OepSFAfuvEtDcRhGE-8ZbYYH-DqIJA7p7exI11FyCKGZrvqsXHkQtzig1hUjpgV904UTZSk1WOIknlbazA6I4SXUuC0ckltMF4dwEp8nCOxNcqaQCvGUXxng0kV85UZhy-vak-AWdRjHND97QesE5xE0JL1QpvTDQhg8c_4uLpMEUOqG9Vf3rR5Q6C0w","e":"AQAB"}]}';
export const AUTH_RESEND_KEY = "resendAPIKey";

export async function signInViaGitHub(
  t: TestConvexForDataModel<DataModel>,
  provider: string,
  githubProfile: Record<string, unknown>,
) {
  const verifier = "123456";
  const { redirect } = await t.action(api.auth.signIn, {
    provider,
    params: {},
    verifier,
  });
  expect(redirect).toEqual(
    process.env.CONVEX_SITE_URL + `/api/auth/signin/${provider}`,
  );

  const url = new URL(redirect!).pathname + `?code=${verifier}`;
  const response = await t.fetch(url);

  expect(response.status).toBe(302);

  const redirectedTo = response.headers.get("Location");
  const cookies = response.headers.get("Set-Cookie");

  expect(redirectedTo).not.toBeNull();
  expect(cookies).not.toBeNull();

  const redirectedToParams = new URL(redirectedTo!).searchParams;

  const callbackUrl = redirectedToParams.get("redirect_uri");

  const codeChallenge = redirectedToParams.get("code_challenge");
  expect(callbackUrl).not.toBeNull();
  expect(codeChallenge).not.toBeNull();

  const issuedOAuthCode = "mightygithub";
  const issuedAccessToken = "veryfancyaccesstoken";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init: RequestInit) => {
      if (input === "https://github.com/login/oauth/access_token") {
        const args = init.body as URLSearchParams;
        expect(args.get("code")).toBe(issuedOAuthCode);
        return new Response(
          JSON.stringify({
            access_token: issuedAccessToken,
            token_type: "bearer",
          }),
          { status: 200 },
        );
      } else if (
        input instanceof URL &&
        input.href === "https://api.github.com/user"
      ) {
        expect(new Headers(init.headers).get("authorization")).toBe(
          `Bearer ${issuedAccessToken}`,
        );
        return new Response(JSON.stringify(githubProfile), { status: 200 });
      }

      throw new Error("Unexpected fetch");
    }),
  );

  const callbackResponse = await t.fetch(
    `${new URL(callbackUrl!).pathname}?code=${issuedOAuthCode}&code_challenge=${codeChallenge}`,
    { headers: { Cookie: cookies! } },
  );

  vi.unstubAllGlobals();
  const finalRedirectedTo = callbackResponse.headers.get("Location");

  expect(finalRedirectedTo).not.toBeNull();
  const code = new URL(finalRedirectedTo!).searchParams.get("code");

  return await t.action(api.auth.signIn, { params: { code }, verifier });
}

export async function signInViaMagicLink(
  t: TestConvexForDataModel<DataModel>,
  provider: string,
  email: string,
) {
  let code;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (
        typeof input === "string" &&
        input === "https://api.resend.com/emails"
      ) {
        code = init.body.match(/\?code=([^\s\\]+)/)?.[1] ?? "";
        expect(code).not.toEqual("");
        return new Response(null, { status: 200 });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  await t.action(api.auth.signIn, { provider, params: { email } });
  vi.unstubAllGlobals();

  // Note: The client doesn't use auth for this call,
  // so ideally this should be `t.withoutIdentity().action(...)`
  const result = await t.action(api.auth.signIn, {
    params: { code },
  });
  return result.tokens ?? null;
}

export async function signInViaOTP(
  t: TestConvexForDataModel<DataModel>,
  provider: string,
  params: Record<string, unknown>,
) {
  const { code } = await mockResendOTP(
    async () => await t.action(api.auth.signIn, { provider, params }),
  );

  // Note: The client doesn't use auth for this call,
  // so ideally this should be `t.withoutIdentity().action(...)`
  const result = await t.action(api.auth.signIn, {
    provider,
    params: { code, ...params },
  });
  return result.tokens ?? null;
}

export async function mockResendOTP<T>(send: () => Promise<T>) {
  let code: string;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (
        typeof input === "string" &&
        input === "https://api.resend.com/emails"
      ) {
        code = cheerio(init.body)("span").text();
        expect(code).not.toEqual("");
        return new Response(JSON.stringify(null), { status: 200 });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  const result = await send();
  vi.unstubAllGlobals();
  return { result, code: code! };
}

export async function signInViaPhone(
  t: TestConvexForDataModel<DataModel>,
  provider: string,
  params: Record<string, unknown>,
) {
  let code;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (typeof input === "string" && input === "https://api.sms.com") {
        code = init.body.match(/Your code is (\d+)/)?.[1];
        return new Response(null, { status: 200 });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  await t.action(api.auth.signIn, { provider, params });
  vi.unstubAllGlobals();

  // Note: The client doesn't use auth for this call,
  // so ideally this should be `t.withoutIdentity().action(...)`
  const result = await t.action(api.auth.signIn, {
    provider,
    params: { code, ...params },
  });
  return result.tokens ?? null;
}

// function clientId(providerId: string) {
//   return `AUTH_${envProviderId(providerId)}_ID`;
// }

// function clientSecret(providerId: string) {
//   return `AUTH_${envProviderId(providerId)}_SECRET`;
// }

// function envProviderId(provider: string) {
//   return provider.toUpperCase().replace(/-/g, "_");
// }
