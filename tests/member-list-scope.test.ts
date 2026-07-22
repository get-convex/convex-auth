import { api } from "@convex/_generated/api";
import { auth as backendAuth } from "@convex/auth";
import { roles } from "@convex/roles";
import schema from "@convex/schema";
import { decodeJwt } from "jose";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { convexTest } from "./convex/setup";
import { subjectToUserId } from "./helpers";

// `capGrantsForCaller` guards three call sites: `member.get`, `member.assert`
// (both pinned in `oauth-scope.test.ts`), and the `member.list({ withGrants })`
// read path pinned here. A scoped OAuth token must never surface grants beyond
// its scope through the list enrichment, while a session keeps its full grants.

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setupAdminMember(t: ReturnType<typeof convexTest>) {
  const signUp = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "list-admin@example.com", password: "44448888", flow: "signUp" },
  });
  if (signUp.kind !== "signedIn") {
    throw new Error("Expected password signUp to return a session");
  }
  const claims = decodeJwt(signUp.session!.token);
  const userId = subjectToUserId(claims.sub!);
  const groupId = await t.run(async (ctx) => {
    const groupId = await backendAuth.group.create(ctx as any, {
      data: { name: "Acme", slug: "acme" },
    });
    await backendAuth.member.create(ctx as any, {
      data: { groupId, userId, roleIds: [roles.orgAdmin.id] },
    });
    return groupId;
  });
  return { sessionSubject: claims.sub!, userId, groupId };
}

async function listGrantsFor(
  runner: Pick<ReturnType<typeof convexTest>, "run">,
  userId: string,
  groupId: string,
): Promise<string[] | null> {
  return await runner.run(async (ctx) => {
    const { page } = await backendAuth.member.list(ctx as any, {
      where: { groupId },
      withGrants: true,
    });
    const item = (page as Array<{ userId: string; grants: string[] }>).find(
      (m) => m.userId === userId,
    );
    return item ? item.grants : null;
  });
}

test("member.list withGrants caps an OAuth caller's grants to the token scope", async () => {
  const t = convexTest(schema);
  const { sessionSubject, userId, groupId } = await setupAdminMember(t);

  // A session (no client_id claim) sees the membership's full orgAdmin grants.
  const sessionGrants = await listGrantsFor(
    t.withIdentity({ subject: sessionSubject, sid: "session1" } as any),
    userId,
    groupId,
  );
  expect(sessionGrants).toContain("members.read");
  expect(sessionGrants).toContain("members.manage");
  expect(sessionGrants).toContain("issues.delete");

  // A scoped OAuth token only sees grants within its scope — the broad grants
  // (members.manage, issues.delete) are filtered out of the list item.
  const oauthGrants = await listGrantsFor(
    t.withIdentity({
      subject: userId,
      client_id: "oc_test",
      scope: "members.read projects.read",
    } as any),
    userId,
    groupId,
  );
  expect(oauthGrants).toContain("members.read");
  expect(oauthGrants).toContain("projects.read");
  expect(oauthGrants).not.toContain("members.manage");
  expect(oauthGrants).not.toContain("issues.delete");
});
