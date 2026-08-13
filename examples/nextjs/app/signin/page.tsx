"use client";

import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";

export default function SignIn() {
  // The provider's own hook, with no SSR-specific variant. The surrounding
  // ConvexAuthNextjsProvider routes this call through the sign-in route, which
  // moves the minted refresh token into an httpOnly cookie so it never reaches
  // JS.
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
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
