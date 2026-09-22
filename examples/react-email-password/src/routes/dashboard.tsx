import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function Dashboard() {
  const user = useQuery(api.currentUser.loggedInUser);
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <>
          <p>
            Signed in as{" "}
            <strong>
              {user.emails.find((entry) => entry.isPrimary)?.email}
            </strong>{" "}
            ({user.id})
          </p>
          <h2>Your email addresses</h2>
          <ul>
            {user.emails.map((entry) => (
              <li key={entry.email}>
                {entry.email}
                {entry.isPrimary ? <strong> (primary)</strong> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Session</h2>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
