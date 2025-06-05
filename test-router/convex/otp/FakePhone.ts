import { PhoneConfig, PhoneUserConfig } from "@convex-dev/auth/server";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

export function FakePhone(config: PhoneUserConfig): PhoneConfig {
  return {
    id: "fake-phone",
    type: "phone",
    maxAge: 60 * 20, // 20 minutes
    async generateVerificationToken() {
      const random: RandomReader = {
        read(bytes) {
          crypto.getRandomValues(bytes);
        },
      };

      const alphabet = "0123456789";
      const length = 6;
      return generateRandomString(random, alphabet, length);
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
