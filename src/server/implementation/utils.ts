import {
  alphabet,
  generateRandomString,
  sha256 as rawSha256,
} from "oslo/crypto";
import { encodeHex } from "oslo/encoding";

export const TOKEN_SUB_CLAIM_DIVIDER = "|";
export const REFRESH_TOKEN_DIVIDER = "|";

export function stringToNumber(value: string | undefined) {
  return value !== undefined ? Number(value) : undefined;
}

export async function sha256(input: string) {
  return encodeHex(await rawSha256(new TextEncoder().encode(input)));
}
