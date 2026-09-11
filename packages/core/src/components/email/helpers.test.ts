import { describe, expect, test } from "vitest";
import { buildLink, challengeEmailText, formatDuration } from "./helpers.ts";

describe("buildLink", () => {
  test("appends the code with ? or & as the URL requires", () => {
    expect(buildLink("https://app.example/validate", "abc")).toBe(
      "https://app.example/validate?code=abc",
    );
    expect(buildLink("https://app.example/validate?flow=signUp", "abc")).toBe(
      "https://app.example/validate?flow=signUp&code=abc",
    );
  });

  test("URL-encodes the code", () => {
    expect(buildLink("https://app.example/v", "a+b/c=")).toBe(
      "https://app.example/v?code=a%2Bb%2Fc%3D",
    );
  });
});

describe("challengeEmailText", () => {
  test("puts the intro, the link and the expiry in the body", () => {
    const text = challengeEmailText(
      "Open this link:",
      "https://app.example/v?code=abc",
      10 * 60_000,
    );
    expect(text).toContain("Open this link:\n\nhttps://app.example/v?code=abc");
    expect(text).toContain("stops working after 10 minutes");
    expect(text).toContain("works only in the browser you started from");
  });
});

describe("formatDuration", () => {
  test("names minutes and whole hours", () => {
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(10 * 60_000)).toBe("10 minutes");
    expect(formatDuration(60 * 60_000)).toBe("1 hour");
    expect(formatDuration(24 * 60 * 60_000)).toBe("24 hours");
    expect(formatDuration(90 * 60_000)).toBe("90 minutes");
  });
});
