import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function Dashboard() {
  const user = useQuery(api.users.currentUser);
  const { signOut } = useAuthActions();

  return (
    <>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user?.email ?? "…"}</strong> — no password on
        file, just proof of control of that inbox.
      </p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}
