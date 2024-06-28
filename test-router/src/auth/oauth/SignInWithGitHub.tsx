import { useAuthActions } from "@convex-dev/auth/react";
import { GitHubLogo } from "@/components/GitHubLogo";
import { Button } from "@/components/ui/button";

export function SignInWithGitHub() {
  const { signIn } = useAuthActions();
  return (
    <Button
      className="flex-1"
      variant="outline"
      type="button"
      onClick={() => void signIn("github")}
    >
      <GitHubLogo className="mr-2 h-4 w-4" /> GitHub
    </Button>
  );
}
