import { SignInWithApple } from "@/app/auth/oauth/SignInWithApple";
import { SignInWithGitHub } from "@/app/auth/oauth/SignInWithGitHub";
import { SignInWithGoogle } from "@/app/auth/oauth/SignInWithGoogle";

export function SignInWithOAuth() {
  return (
    <div className="flex flex-col min-[460px]:flex-row w-full gap-2 items-stretch">
      <SignInWithGitHub />
      <SignInWithGoogle />
      <SignInWithApple />
    </div>
  );
}
