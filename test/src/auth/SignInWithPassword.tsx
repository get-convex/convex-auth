"use client";

import { useAuthActions } from "@/app/ConvexAuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

export function SignInWithPassword({
  provider,
  handleSent,
  handlePasswordReset,
}: {
  provider?: string;
  handleSent?: () => void;
  handlePasswordReset?: () => void;
}) {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const { toast } = useToast();

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        formData.set("flow", flow);
        signIn(provider ?? "password", formData)
          .then(() => {
            handleSent?.();
          })
          .catch((error) => {
            console.error(error);
            const title =
              flow === "signIn"
                ? "Could not sign in, did you mean to sign up?"
                : "Could not sign up, did you mean to sign in?";
            toast({ title, variant: "destructive" });
          });
      }}
    >
      <label htmlFor="email">Email</label>
      <Input name="email" id="email" className="mb-4" autoComplete="email" />
      <div className="flex items-center justify-between">
        <label htmlFor="password">Password</label>
        {handlePasswordReset && flow === "signIn" ? (
          <Button
            className="p-0 h-auto"
            type="button"
            variant="link"
            onClick={handlePasswordReset}
          >
            Forgot your password?
          </Button>
        ) : null}
      </div>
      <Input
        type="password"
        name="password"
        id="password"
        className="mb-4 "
        autoComplete={flow === "signIn" ? "current-password" : "new-password"}
      />
      <Button type="submit">{flow === "signIn" ? "Sign in" : "Sign up"}</Button>
      <Button
        variant="link"
        type="button"
        onClick={() => {
          setFlow(flow === "signIn" ? "signUp" : "signIn");
        }}
      >
        {flow === "signIn"
          ? "Don't have an account? Sign up"
          : "Already have an account? Sign in"}
      </Button>
    </form>
  );
}
