"use client";

import { Preloaded, usePreloadedQuery } from "convex/react";
import { useAuthActions, useAuthToken } from "@convex-dev/auth/nextjs";
import { api } from "@/convex/_generated/api";

/**
 * Hydrates from the server-preloaded query (so it renders the user immediately),
 * then stays live via the websocket. The access token comes from the client
 * provider that the server seeded; the refresh token is never visible here.
 */
export function Dashboard({
  preloaded,
}: {
  preloaded: Preloaded<typeof api.users.loggedInUser>;
}) {
  const user = usePreloadedQuery(preloaded);
  const token = useAuthToken();
  const { signOut } = useAuthActions();
  return (
    <>
      <p>
        Signed in as <strong>{user ? user.name : "…"}</strong>
        {user ? ` (${user._id})` : ""}
      </p>
      <p style={{ wordBreak: "break-all", color: "#666", fontSize: "0.8rem" }}>
        Access token: {token ? `${token.slice(0, 24)}…` : "(none)"}
      </p>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
