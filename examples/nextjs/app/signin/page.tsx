"use client";

import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";

/**
 * Client sign-in. `useAnonymousAuth` runs the provider's sign-in mutation and
 * hands the resulting bundle to `setSession`, which (in the Next.js provider)
 * POSTs it to the auth route so the refresh token lands in an httpOnly cookie.
 * Then we navigate home; middleware sees the session and allows it.
 */
export default function SignIn() {
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  const router = useRouter();
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Convex Auth — Next.js SSR</h1>
      <p>You are signed out.</p>
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
