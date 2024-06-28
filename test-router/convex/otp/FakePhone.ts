import { PhoneConfig, PhoneUserConfig } from "@convex-dev/auth/server";
import { alphabet, generateRandomString } from "oslo/crypto";

export function FakePhone(config: PhoneUserConfig): PhoneConfig {
  return {
    id: "fake-phone",
    type: "phone",
    maxAge: 60 * 20, // 20 minutes
    async generateVerificationToken() {
      return generateRandomString(6, alphabet("0-9"));
    },
    async sendVerificationRequest({ identifier: phone, provider, token }) {
      const response = await fetch("https://api.sms.com", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: phone,
          text: `Your code is ${token}.`,
        }),
      });

      if (!response.ok) {
        throw new Error("Could not send verification code email");
      }
    },
    options: config,
  };
}
