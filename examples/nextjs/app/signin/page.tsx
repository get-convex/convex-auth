"use client";

import { useAnonymousAuth } from "@convex-dev/auth/nextjs";
import { useRouter } from "next/navigation";

export default function SignIn() {
  // SSR sibling of the client-direct hook: sign-in runs on the server (POST to
  // /auth/signin/anonymous), so the refresh token never reaches JS.
  const { signInAnonymous } = useAnonymousAuth();
  const router = useRouter();
  return (
    <main style={{ padding: 24, maxWidth: 640 }}>
      <h1>Sign in</h1>
      <button
        onClick={async () => {
          await signInAnonymous();
          router.push("/");
        }}
      >
        Sign in anonymously
      </button>
    </main>
  );
}
