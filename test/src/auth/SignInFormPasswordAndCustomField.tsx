import { SignInWithPassword } from "@/auth/SignInWithPassword";
import { Toaster } from "@/components/ui/toaster";
import { useState } from "react";
import { HexColorPicker } from "react-colorful";

export function SignInFormPasswordAndCustomField() {
  const [color, setColor] = useState<string | null>(null);
  return (
    <div className="max-w-[384px] mx-auto flex flex-col gap-4">
      <h2 className="font-semibold text-2xl tracking-tight">
        Sign in or create an account
      </h2>
      <SignInWithPassword
        provider="password-custom"
        passwordRequirements="6 or more characters with uppercase, lowercase and digits"
        customSignUp={
          <>
            {color !== null && (
              <input name="favoriteColor" value={color} type="hidden" />
            )}
            <span className="mt-4">Favorite Color</span>
            <div
              style={{ backgroundColor: color ?? "transparent" }}
              className="h-9 w-full mb-2 rounded-md border border-gray-800"
            >
              &nbsp;
            </div>
            <HexColorPicker
              color={color ?? "#aabbcc"}
              onChange={setColor}
              className="mb-4 w-max"
            />
          </>
        }
      />
      <Toaster />
    </div>
  );
}
