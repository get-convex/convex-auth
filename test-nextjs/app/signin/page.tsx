"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { GitHubLogo } from "@/components/GitHubLogo";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function Sign() {
  return (
    <div className="flex min-h-screen w-full">
      <main className="mx-auto my-auto flex-col flex">
        <h2 className="font-semibold text-2xl tracking-tight mb-4">
          Sign in or create an account
        </h2>
        <SignInWithGitHub />

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
