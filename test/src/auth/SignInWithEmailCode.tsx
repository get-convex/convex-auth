"use client";

import { useAuthActions } from "@/app/ConvexAuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";

export function SignInWithEmailCode({
  handleCodeSent,
  provider,
  children,
}: {
  handleCodeSent: () => void;
  provider?: string;
  children?: React.ReactNode;
}) {
  const { signIn } = useAuthActions();
  const { toast } = useToast();
  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        signIn(provider ?? "resend-otp", formData)
          .then(handleCodeSent)
          .catch((error) => {
            console.error(error);
            toast({
              title: "Could not send code",
              variant: "destructive",
            });
          });
      }}
    >
      <label htmlFor="email">Email</label>
      <Input name="email" id="email" className="mb-4" autoComplete="email" />
      {children}
      <Button type="submit">Send code</Button>
    </form>
  );
}
