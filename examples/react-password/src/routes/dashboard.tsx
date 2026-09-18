import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { PasswordSettings } from "../PasswordSettings";
import { TotpSettings } from "../TotpSettings";

export function Dashboard() {
  const user = useQuery(api.currentUser.loggedInUser);
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <>
          <p>
            Signed in as <strong>{user.username}</strong> ({user.id})
          </p>
          <PasswordSettings />
          <TotpSettings />
        </>
      )}
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
