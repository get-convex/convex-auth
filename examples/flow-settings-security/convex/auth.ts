/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * This fixture assumes the user is ALREADY signed in — any sign-in fixture
 * (e.g. flow-password-email-verify) can front it. This file therefore holds
 * only the standard session plumbing; the account-security surface (linked
 * identities, sessions, passkeys, step-up) lives in ./security.ts.
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { todo, vTokenBundle } from "./authTypes";

// --- Standard session plumbing (matches the existing client contract) -----

export const refreshSession = mutation({
  args: { refreshToken: v.string() },
  returns: v.union(vTokenBundle, v.null()),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): rotate the refresh token (reuse detection, grace
    // window); return null for dead sessions.
    return todo("refreshSession");
  },
});

export const signOut = mutation({
  args: { refreshToken: v.string() },
  returns: v.null(),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): revoke the session; idempotent.
    return todo("signOut");
  },
});
