import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute, useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/loggedin")({
  component: About,
});

function About() {
  return (
    <div className="p-2">
      Hello from About!
      <SignOut />
    </div>
  );
}

function SignOut() {
  const { signOut } = useAuthActions();
  const router = useRouter();
  return (
    <button
      onClick={() => void signOut().then(() => router.navigate({ to: "/" }))}
    >
      Sign out
    </button>
  );
}
