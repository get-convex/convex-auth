// import { SignInFormAnonymous } from "@/auth/SignInFormAnonymous";
import { SignInFormEmailCode } from "@/auth/SignInFormEmailCode";
import { SignInFormEmailLink } from "@/auth/SignInFormEmailLink";
import { SignInFormPassword } from "@/auth/SignInFormPassword";
import { SignInFormPasswordAndResetViaCode } from "@/auth/SignInFormPasswordAndResetViaCode";
import { SignInFormPasswordAndVerifyViaCode } from "@/auth/SignInFormPasswordAndVerifyViaCode";
import { SignInFormPasswordAndCustomField } from "@/auth/SignInFormPasswordAndCustomField";
import { SignInFormPhoneCode } from "@/auth/SignInFormPhoneCode";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// This component is here to showcase different combinations of sign-in methods.
// 1. Choose one of the forms and use it directly instead of this component.
// 2. Delete or add OAuth providers as needed.
// 3. Delete the unused forms.
export function SignInFormsShowcase() {
  return (
    <Tabs defaultValue="otp" className="container flex flex-col mt-10">
      <TabsList className="ml-auto mr-10 mb-1 opacity-60 overflow-x-scroll max-w-full justify-start">
        <TabsTrigger value="otp">OTP</TabsTrigger>
        <TabsTrigger value="link">Magic Link</TabsTrigger>
        <TabsTrigger value="password">Password</TabsTrigger>
        {/* <TabsTrigger value="anonymous">Anonymous</TabsTrigger> */}
      </TabsList>
      <TabsContent value="otp">
        <Tabs defaultValue="email" className="flex flex-col">
          <TabsList className="ml-auto mr-10 mb-7 opacity-60">
            <TabsTrigger value="email">OAuth + Email</TabsTrigger>
            <TabsTrigger value="phone">SMS</TabsTrigger>
          </TabsList>
          <TabsContent value="email">
            {/* Sign in via emailed OTP */}
            <SignInFormEmailCode />
          </TabsContent>
          <TabsContent value="phone">
            {/* Sign in via SMS OTP */}
            <SignInFormPhoneCode />
          </TabsContent>
        </Tabs>
      </TabsContent>
      <TabsContent className="mt-20" value="link">
        {/* Sign in via magic link */}
        <SignInFormEmailLink />
      </TabsContent>
      <TabsContent value="password">
        <Tabs defaultValue="basic" className="flex flex-col">
          <TabsList className="ml-auto mr-10 mb-7 opacity-60 overflow-x-scroll max-w-full justify-start">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="custom">Custom Sign Up</TabsTrigger>
            <TabsTrigger value="password reset">Password Reset</TabsTrigger>
            <TabsTrigger value="email verification">
              OAuth + Email Verification
            </TabsTrigger>
          </TabsList>
          <TabsContent value="basic">
            {/* Simplest email + password, no recovery */}
            <SignInFormPassword />
          </TabsContent>
          <TabsContent value="custom">
            {/* Email + password and custom field in sign up flow */}
            <SignInFormPasswordAndCustomField />
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
      {/* Sign in anonymously */}
      {/* <TabsContent className="mt-20" value="anonymous">
        <SignInFormAnonymous />
      </TabsContent> */}
    </Tabs>
  );
}
