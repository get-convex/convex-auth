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
        Signed in as <strong>{user?.email ?? "…"}</strong>.
      </p>
      <ul>
        <li>
          Display name: <strong>{user?.displayName ?? "…"}</strong>
        </li>
        <li>
          Role: <strong>{user?.role ?? "…"}</strong>
        </li>
        <li>
          Terms accepted: <strong>v{user?.tosAcceptedVersion ?? "…"}</strong>
        </li>
      </ul>
      <p>
        Every field above was validated server-side and recorded when the
        user was created — this account could not exist without them.
      </p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}
