import { Button } from "@/components/ui/button";
import { useAuthActions } from "@convex-dev/auth/react";
import { NavigateOptions, createLazyFileRoute } from "@tanstack/react-router";

export const Route = createLazyFileRoute("/")({
  component: Index,
});

function Index() {
  const { signIn } = useAuthActions();

  return (
    <div className="p-2">
      <h3>Welcome!</h3>
      <Button
        onClick={() =>
          void signIn("github", {
            redirectTo: "/loggedin" satisfies NavigateOptions["to"],
          })
        }
      >
        Sign in with Github
      </Button>
    </div>
  );
}
