"use client";

import { SignInFormEmailCode } from "@/app/auth/SignInFormEmailCode";
import { SignInFormEmailLink } from "@/app/auth/SignInFormEmailLink";
import { SignInFormPassword } from "@/app/auth/SignInFormPassword";
import { SignInFormPasswordAndResetViaCode } from "@/app/auth/SignInFormPasswordAndResetViaCode";
import { SignInFormPasswordAndVerifyViaCode } from "@/app/auth/SignInFormPasswordAndVerifyViaCode";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// This component is here to showcase different combinations of sign-in methods.
// 1. Choose one of the forms and use it directly instead of this component.
// 2. Delete or add OAuth providers as needed.
// 3. Delete the unused forms.
export function SignInFormsShowcase() {
  return (
    <Tabs defaultValue="password" className="flex flex-col">
      <TabsList className="mx-auto mb-1">
        <TabsTrigger value="password">Password</TabsTrigger>
        <TabsTrigger value="code">OTP</TabsTrigger>
        <TabsTrigger value="link">Magic Link</TabsTrigger>
      </TabsList>
      <TabsContent className="mt-20" value="code">
        {/* Sign in via OTP */}
        <SignInFormEmailCode />
      </TabsContent>
      <TabsContent className="mt-20" value="link">
        {/* Sign in via magic link */}
        <SignInFormEmailLink />
      </TabsContent>
      <TabsContent value="password">
        <Tabs defaultValue="basic" className="flex flex-col">
          <TabsList className="mx-auto mb-7">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="password reset">Password Reset</TabsTrigger>
            <TabsTrigger value="email verification">
              Email Verification
            </TabsTrigger>
          </TabsList>
          <TabsContent value="basic">
            {/* Simplest email + password, no recovery */}
            <SignInFormPassword />
          </TabsContent>
          <TabsContent value="password reset">
            {/* Email + password, plus password reset via OTP */}
            <SignInFormPasswordAndResetViaCode />
          </TabsContent>
          <TabsContent value="email verification">
            {/* Email + password, plus email verification and password
                    reset via OTP */}
            <SignInFormPasswordAndVerifyViaCode />
          </TabsContent>
        </Tabs>
      </TabsContent>
    </Tabs>
  );
}
