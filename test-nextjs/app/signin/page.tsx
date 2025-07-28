"use client";

import { GitHubLogo } from "@/components/GitHubLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthActions } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Sign() {
  return (
    <div className="flex min-h-screen w-full">
      <main className="mx-auto my-auto flex-col flex">
        <h2 className="font-semibold text-2xl tracking-tight mb-4">
          Sign in or create an account
        </h2>
        <SignInWithGitHub />
        {process.env.NEXT_PUBLIC_E2E_TEST && <SignInWithSecret />}

        <Button variant="link" className="text-muted-foreground" asChild>
          <Link href="/">Cancel</Link>
        </Button>
      </main>
    </div>
  );
}

function SignInWithGitHub() {
  const { signIn } = useAuthActions();
  return (
    <Button
      className="flex-1"
      variant="outline"
      type="button"
      onClick={() => void signIn("github", { redirectTo: "/product" })}
    >
      <GitHubLogo className="mr-2 h-4 w-4" /> GitHub
    </Button>
  );
}

// Only used in automated e2e tests
function SignInWithSecret() {
  const { signIn } = useAuthActions();
  const router = useRouter();
  return (
    <form
      className="flex flex-col gap-2 mt-8"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        signIn("secret", formData)
          .then(() => {
            router.push("/product");
          })
          .catch((e) => {
            // Ensure error message comes back from the backend
            if (e.message.includes("Uncaught Error: Invalid secret")) {
              window.alert("Invalid secret");
            } else {
              window.alert(e.message);
            }
          });
      }}
    >
      Test only: Sign in with a secret
      <Input
        aria-label="Secret"
        type="text"
        name="secret"
        placeholder="secret value"
      />
      <Button className="flex-1" variant="outline" type="submit">
        Sign in with secret
      </Button>
    </form>
  );
}
