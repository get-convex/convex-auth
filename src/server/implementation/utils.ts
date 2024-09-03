import { sha256 as rawSha256 } from "oslo/crypto";
import { encodeHex } from "oslo/encoding";

export const TOKEN_SUB_CLAIM_DIVIDER = "|";
export const REFRESH_TOKEN_DIVIDER = "|";

export function stringToNumber(value: string | undefined) {
  return value !== undefined ? Number(value) : undefined;
}

export async function sha256(input: string) {
  return encodeHex(await rawSha256(new TextEncoder().encode(input)));
}

export function logError(error: unknown) {
  console.error(
    error instanceof Error
      ? error.message + "\n" + error.stack?.replace("\\n", "\n")
      : error,
  );
}
