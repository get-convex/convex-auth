import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function Dashboard() {
  const user = useQuery(api.users.loggedInUser);
  const token = useAuthToken();
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <p>
          Signed in as <strong>{user.username}</strong> ({user.id})
        </p>
      )}
      <p>Access token: {token ? `${token.slice(0, 24)}…` : "(none)"}</p>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
