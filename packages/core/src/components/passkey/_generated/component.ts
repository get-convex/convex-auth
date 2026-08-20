/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    authentication: {
      finishAuthentication: FunctionReference<
        "mutation",
        "internal",
        {
          expectedOrigin: string;
          expectedRpId: string;
          response: {
            authenticatorAttachment?: "cross-platform" | "platform";
            clientExtensionResults: any;
            id: string;
            rawId: string;
            response: {
              authenticatorData: string;
              clientDataJSON: string;
              signature: string;
              userHandle?: string;
            };
            type: "public-key";
          };
        },
        | { passkeyId: string; success: true; userId: string }
        | {
            success: false;
            userError:
              | { error: "UNKNOWN_CREDENTIAL" }
              | { error: "CHALLENGE_EXPIRED" }
              | { error: "VERIFICATION_FAILED" };
          },
        Name
      >;
      startAuthentication: FunctionReference<
        "mutation",
        "internal",
        { userId?: string },
        {
          allowCredentials: Array<{
            id: string;
            transports?: Array<
              | "ble"
              | "cable"
              | "hybrid"
              | "internal"
              | "nfc"
              | "smart-card"
              | "usb"
            >;
          }>;
          challenge: string;
        },
        Name
      >;
    };
    registration: {
      checkRegistration: FunctionReference<
        "query",
        "internal",
        {
          expectedOrigin: string;
          expectedRpId: string;
          response: {
            authenticatorAttachment?: "cross-platform" | "platform";
            clientExtensionResults: any;
            id: string;
            rawId: string;
            response: {
              attestationObject: string;
              authenticatorData?: string;
              clientDataJSON: string;
              publicKey?: string;
              publicKeyAlgorithm?: number;
              transports?: Array<
                | "ble"
                | "cable"
                | "hybrid"
                | "internal"
                | "nfc"
                | "smart-card"
                | "usb"
              >;
            };
            type: "public-key";
          };
        },
        | { success: true }
        | {
            success: false;
            userError:
              { error: "CHALLENGE_EXPIRED" } | { error: "VERIFICATION_FAILED" };
          },
        Name
      >;
      deletePasskey: FunctionReference<
        "mutation",
        "internal",
        { passkeyId: string; userId: string },
        | { success: true }
        | { success: false; userError: { error: "PASSKEY_NOT_FOUND" } },
        Name
      >;
      deleteUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        null,
        Name
      >;
      finishRegistration: FunctionReference<
        "mutation",
        "internal",
        {
          expectedOrigin: string;
          expectedRpId: string;
          name?: string;
          response: {
            authenticatorAttachment?: "cross-platform" | "platform";
            clientExtensionResults: any;
            id: string;
            rawId: string;
            response: {
              attestationObject: string;
              authenticatorData?: string;
              clientDataJSON: string;
              publicKey?: string;
              publicKeyAlgorithm?: number;
              transports?: Array<
                | "ble"
                | "cable"
                | "hybrid"
                | "internal"
                | "nfc"
                | "smart-card"
                | "usb"
              >;
            };
            type: "public-key";
          };
          verifiedUserId: string;
        },
        | { passkeyId: string; success: true }
        | {
            success: false;
            userError:
              { error: "CHALLENGE_EXPIRED" } | { error: "VERIFICATION_FAILED" };
          },
        Name
      >;
      listPasskeys: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          createdAt: number;
          credentialId: string;
          name?: string;
          passkeyId: string;
        }>,
        Name
      >;
      startRegistration: FunctionReference<
        "mutation",
        "internal",
        { userId: string | null },
        {
          challenge: string;
          excludeCredentials: Array<{
            id: string;
            transports?: Array<
              | "ble"
              | "cable"
              | "hybrid"
              | "internal"
              | "nfc"
              | "smart-card"
              | "usb"
            >;
          }>;
          userHandle: string;
        },
        Name
      >;
    };
  };
