import { Button } from "@/components/ui/button";
import { useAuthActions } from "@convex-dev/auth/react";

export function SignInFormAnonymous() {
  const { signIn } = useAuthActions();
  return (
    <div className="max-w-[384px] mx-auto flex flex-col gap-4">
      <>
        <h2 className="font-semibold text-2xl tracking-tight">
          Sign in anonymously
        </h2>
        <Button
          type="submit"
          onClick={() => {
            void signIn("anonymous");
          }}
        >
          Sign in
        </Button>
      </>
    </div>
  );
}
