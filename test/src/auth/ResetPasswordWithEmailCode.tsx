import { useAuthActions } from "@convex-dev/auth/react";
import { CodeInput } from "@/auth/CodeInput";
import { SignInWithEmailCode } from "@/auth/SignInWithEmailCode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

export function ResetPasswordWithEmailCode({
  handleCancel,
  provider,
}: {
  handleCancel: () => void;
  provider: string;
}) {
  const { signIn } = useAuthActions();
  const { toast } = useToast();
  const [step, setStep] = useState<"forgot" | { email: string }>("forgot");

  return step === "forgot" ? (
    <>
      <h2 className="font-semibold text-2xl tracking-tight">
        Send password reset code
      </h2>
      <SignInWithEmailCode
        handleCodeSent={(email) => setStep({ email })}
        provider={provider}
      >
        <input name="flow" type="hidden" value="reset" />
      </SignInWithEmailCode>
      <Button type="button" variant="link" onClick={handleCancel}>
        Cancel
      </Button>
    </>
  ) : (
    <>
      <h2 className="font-semibold text-2xl tracking-tight">
        Check your email
      </h2>
      <p className="text-muted-foreground text-sm">
        Enter the 8-digit code we sent to your email address and choose a new
        password.
      </p>
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          signIn(provider, formData).catch(() => {
            toast({
              title:
                "Code could not be verified or new password is too short, try again",
              variant: "destructive",
            });
          });
        }}
      >
        <label htmlFor="email">Code</label>
        <CodeInput />
        <label htmlFor="newPassword">New Password</label>
        <Input
          type="password"
          name="newPassword"
          id="newPassword"
          className="mb-4 "
          autoComplete="new-password"
        />
        <input type="hidden" name="flow" value="reset-verification" />
        <input type="hidden" name="email" value={step.email} />
        <Button type="submit">Continue</Button>
        <Button type="button" variant="link" onClick={() => setStep("forgot")}>
          Cancel
        </Button>
      </form>
    </>
  );
}
