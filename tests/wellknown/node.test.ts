import { wellKnown } from "@robelest/convex-auth/server";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

const ENV_KEYS = [
  "IOS_APP_IDS",
  "IOS_APPLINK_PATHS",
  "ANDROID_APP_LINKS",
  "APP_URL",
  "SECURITY_CONTACT",
  "SECURITY_TXT_EXPIRES_DAYS",
  "CHANGE_PASSWORD_URL",
] as const;

const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
});

test("AASA returns null when neither env nor opts provided", () => {
  expect(wellKnown("apple-app-site-association")).toBeNull();
});

test("AASA reads IOS_APP_IDS and falls back to default applink paths", () => {
  process.env.IOS_APP_IDS = "ABC123DEF.com.example.app,ABC123DEF.com.example.staging";
  const r = wellKnown("apple-app-site-association");
  expect(r).not.toBeNull();
  const body = JSON.parse(r!.body) as {
    applinks: { details: Array<{ appIDs: string[]; components: Array<{ "/": string }> }> };
    webcredentials: { apps: string[] };
  };
  expect(body.webcredentials.apps).toEqual([
    "ABC123DEF.com.example.app",
    "ABC123DEF.com.example.staging",
  ]);
  expect(body.applinks.details[0]!.appIDs).toEqual([
    "ABC123DEF.com.example.app",
    "ABC123DEF.com.example.staging",
  ]);
  expect(body.applinks.details[0]!.components).toEqual([
    { "/": "/auth/*" },
    { "/": "/callback/*" },
  ]);
  expect(r!.headers["Content-Type"]).toBe("application/json");
});

test("AASA respects IOS_APPLINK_PATHS override", () => {
  process.env.IOS_APP_IDS = "T1.com.example.app";
  process.env.IOS_APPLINK_PATHS = "/invite/*,/share/*";
  const r = wellKnown("apple-app-site-association");
  const body = JSON.parse(r!.body) as {
    applinks: { details: Array<{ components: Array<{ "/": string }> }> };
  };
  expect(body.applinks.details[0]!.components).toEqual([{ "/": "/invite/*" }, { "/": "/share/*" }]);
});

test("AASA opts.appIds overrides env", () => {
  process.env.IOS_APP_IDS = "T1.com.example.env";
  const r = wellKnown("apple-app-site-association", {
    appleAppSiteAssociation: { appIds: ["T2.com.example.code"] },
  });
  const body = JSON.parse(r!.body) as { webcredentials: { apps: string[] } };
  expect(body.webcredentials.apps).toEqual(["T2.com.example.code"]);
});

test("assetlinks returns null when nothing configured", () => {
  expect(wellKnown("assetlinks.json")).toBeNull();
});

test("assetlinks parses ANDROID_APP_LINKS env", () => {
  process.env.ANDROID_APP_LINKS = "com.example.app:AA:BB:CC;com.example.staging:DD:EE:FF";
  const r = wellKnown("assetlinks.json");
  expect(r).not.toBeNull();
  const body = JSON.parse(r!.body) as Array<{
    relation: string[];
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
  }>;
  expect(body).toHaveLength(2);
  expect(body[0]!.target.namespace).toBe("android_app");
  expect(body[0]!.target.package_name).toBe("com.example.app");
  expect(body[0]!.target.sha256_cert_fingerprints).toEqual(["AA:BB:CC"]);
  expect(body[0]!.relation).toEqual([
    "delegate_permission/common.get_login_creds",
    "delegate_permission/common.handle_all_urls",
  ]);
  expect(body[1]!.target.package_name).toBe("com.example.staging");
});

test("assetlinks opts.apps overrides env", () => {
  process.env.ANDROID_APP_LINKS = "com.example.env:AA";
  const r = wellKnown("assetlinks.json", {
    assetLinks: {
      apps: [{ packageName: "com.example.code", sha256Fingerprints: ["AA:BB"] }],
    },
  });
  const body = JSON.parse(r!.body) as Array<{ target: { package_name: string } }>;
  expect(body).toHaveLength(1);
  expect(body[0]!.target.package_name).toBe("com.example.code");
});

test("assetlinks output is a top-level array, not an object", () => {
  const r = wellKnown("assetlinks.json", {
    assetLinks: {
      apps: [{ packageName: "com.example.app", sha256Fingerprints: ["AA"] }],
    },
  });
  expect(r!.body.startsWith("[")).toBe(true);
});

test("webauthn returns null without APP_URL", () => {
  expect(wellKnown("webauthn")).toBeNull();
});

test("webauthn derives origins from APP_URL", () => {
  process.env.APP_URL = "https://app.example.com/";
  const r = wellKnown("webauthn");
  const body = JSON.parse(r!.body) as { origins: string[] };
  expect(body.origins).toEqual(["https://app.example.com"]);
});

test("security.txt returns null without contact", () => {
  expect(wellKnown("security.txt")).toBeNull();
});

test("security.txt has unexpired Expires field in ISO 8601", () => {
  process.env.SECURITY_CONTACT = "mailto:security@example.com";
  const r = wellKnown("security.txt");
  expect(r!.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
  expect(r!.body).toContain("Contact: mailto:security@example.com");
  const expiresMatch = /Expires: (.+)$/m.exec(r!.body);
  expect(expiresMatch).not.toBeNull();
  const expires = new Date(expiresMatch![1]!);
  expect(expires.toISOString()).toBe(expiresMatch![1]);
  expect(expires.getTime()).toBeGreaterThan(Date.now());
});

test("security.txt SECURITY_TXT_EXPIRES_DAYS controls expiry", () => {
  process.env.SECURITY_CONTACT = "mailto:security@example.com";
  process.env.SECURITY_TXT_EXPIRES_DAYS = "30";
  const r = wellKnown("security.txt");
  const expires = new Date(/Expires: (.+)$/m.exec(r!.body)![1]!);
  const days = (expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  expect(days).toBeGreaterThan(29);
  expect(days).toBeLessThan(31);
});

test("security.txt includes optional fields", () => {
  process.env.SECURITY_CONTACT = "mailto:security@example.com";
  const r = wellKnown("security.txt", {
    securityTxt: {
      preferredLanguages: ["en", "de"],
      canonical: "https://example.com/.well-known/security.txt",
      encryption: "https://example.com/pgp.txt",
      acknowledgments: "https://example.com/hall-of-fame",
      policy: "https://example.com/security-policy",
      hiring: "https://example.com/jobs",
    },
  });
  expect(r!.body).toContain("Preferred-Languages: en, de");
  expect(r!.body).toContain("Canonical: https://example.com/.well-known/security.txt");
  expect(r!.body).toContain("Encryption: https://example.com/pgp.txt");
  expect(r!.body).toContain("Acknowledgments: https://example.com/hall-of-fame");
  expect(r!.body).toContain("Policy: https://example.com/security-policy");
  expect(r!.body).toContain("Hiring: https://example.com/jobs");
});

test("change-password returns null when not configured", () => {
  expect(wellKnown("change-password")).toBeNull();
});

test("change-password emits 302 with Location header from env", () => {
  process.env.CHANGE_PASSWORD_URL = "https://app.example.com/settings/security";
  const r = wellKnown("change-password");
  expect(r!.status).toBe(302);
  expect(r!.headers.Location).toBe("https://app.example.com/settings/security");
  expect(r!.body).toBe("");
});

test("change-password opts.targetUrl overrides env", () => {
  process.env.CHANGE_PASSWORD_URL = "https://env.example.com/sec";
  const r = wellKnown("change-password", {
    changePassword: { targetUrl: "https://code.example.com/sec" },
  });
  expect(r!.headers.Location).toBe("https://code.example.com/sec");
});
