import { SignInMethodDivider } from "@/auth/SignInMethodDivider";
import { SignInWithOAuth } from "@/auth/SignInWithOAuth";
import { SignInWithPassword } from "@/auth/SignInWithPassword";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { useState } from "react";

/**
 * Users choose between OAuth providers or email and password combo
 * with required email verification via a link.
 *
 * Note: This form is not showcased because it does not include
 * password reset flow, because password reset flow via magic links
 * requires routing.
 */
export function SignInFormPasswordAndVerifyViaLink() {
  const [step, setStep] = useState<"signIn" | "linkSent">("signIn");
  return (
    <div className="max-w-[384px] mx-auto flex flex-col gap-4">
      {step === "signIn" ? (
        <>
          <h2 className="font-semibold text-2xl tracking-tight">
            Sign in or create an account
          </h2>
          <SignInWithOAuth />
          <SignInMethodDivider />
          <SignInWithPassword
            handleSent={() => setStep("linkSent")}
            provider="password-link"
          />
        </>
      ) : (
        <>
          <h2 className="font-semibold text-2xl tracking-tight">
            Check your email
          </h2>
          <p>A verification link has been sent to your email address.</p>
          <Button
            className="p-0 self-start"
            variant="link"
            onClick={() => setStep("signIn")}
          >
            Cancel
          </Button>
        </>
      )}
      <Toaster />
    </div>
  );
}
