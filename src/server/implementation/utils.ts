export const TOKEN_SUB_CLAIM_DIVIDER = "|";
export const REFRESH_TOKEN_DIVIDER = "|";

export function stringToNumber(value: string | undefined) {
  return value !== undefined ? Number(value) : undefined;
}
