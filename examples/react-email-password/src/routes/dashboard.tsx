import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function Dashboard() {
  const user = useQuery(api.currentUser.loggedInUser);
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <p>
          Signed in as <strong>{user.email}</strong> ({user.id})
        </p>
      )}
      <h2>Session</h2>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
