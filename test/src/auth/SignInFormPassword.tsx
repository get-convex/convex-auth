"use client";

import { SignInMethodDivider } from "@/app/auth/SignInMethodDivider";
import { SignInWithOAuth } from "@/app/auth/SignInWithOAuth";
import { SignInWithPassword } from "@/app/auth/SignInWithPassword";
import { Toaster } from "@/components/ui/toaster";

export function SignInFormPassword() {
  return (
    <div className="max-w-[384px] mx-auto flex flex-col gap-4">
      <h2 className="font-semibold text-2xl tracking-tight">
        Sign in or create an account
      </h2>
      <SignInWithOAuth />
      <SignInMethodDivider />
      <SignInWithPassword />
      <Toaster />
    </div>
  );
}
