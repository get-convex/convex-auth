import { NextResponse } from "next/server";
import { getResponseCookies } from "./cookies";

export function jsonResponse(body: any) {
  return new NextResponse(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

export function setAuthCookies(
  response: NextResponse,
  tokens: { token: string; refreshToken: string } | null,
) {
  const responseCookies = getResponseCookies(response);
  if (tokens === null) {
    responseCookies.token = null;
    responseCookies.refreshToken = null;
  } else {
    responseCookies.token = tokens.token;
    responseCookies.refreshToken = tokens.refreshToken;
  }
  responseCookies.verifier = null;
}
