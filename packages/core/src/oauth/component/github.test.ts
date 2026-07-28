import { describe, expect, test } from "vitest";
import { normalizeGithubProfile } from "./github";

/** Call the mapping with the userinfo responses the callback would pass. */
function normalize(
  user: Record<string, unknown>,
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>,
) {
  return normalizeGithubProfile(undefined, { user, emails });
}

describe("normalizeGithubProfile", () => {
  test("prefers the primary verified email", () => {
    const profile = normalize({ id: 1, login: "octocat" }, [
      { email: "secondary@example.com", primary: false, verified: true },
      { email: "primary@example.com", primary: true, verified: true },
      { email: "unverified@example.com", primary: false, verified: false },
    ]);
    expect(profile.email).toBe("primary@example.com");
    expect(profile.emailVerified).toBe(true);
  });

  test("falls back to any verified email when none is primary", () => {
    const profile = normalize({ id: 1, login: "octocat" }, [
      { email: "unverified@example.com", primary: true, verified: false },
      { email: "verified@example.com", primary: false, verified: true },
    ]);
    expect(profile.email).toBe("verified@example.com");
    expect(profile.emailVerified).toBe(true);
  });

  test("falls back to the user endpoint email, marked unverified", () => {
    const profile = normalize(
      { id: 1, login: "octocat", email: "user@example.com" },
      [{ email: "unverified@example.com", primary: true, verified: false }],
    );
    expect(profile.email).toBe("user@example.com");
    expect(profile.emailVerified).toBe(false);
  });

  test("stringifies the id and falls back name to the login", () => {
    const profile = normalize({
      id: 42,
      login: "octocat",
      avatar_url: "https://a/x.png",
    });
    expect(profile.id).toBe("42");
    expect(profile.login).toBe("octocat");
    expect(profile.name).toBe("octocat");
    expect(profile.avatarUrl).toBe("https://a/x.png");
    expect(profile.email).toBeUndefined();
  });

  test("uses the provided name when present", () => {
    const profile = normalize({ id: 1, login: "octocat", name: "The Octocat" });
    expect(profile.name).toBe("The Octocat");
  });

  test("throws when the user response is missing", () => {
    expect(() => normalizeGithubProfile(undefined, {})).toThrow(
      /missing the `user` entry/,
    );
  });
});
