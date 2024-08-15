import "server-only";

import { fetchAction } from "convex/nextjs";
import { NextRequest } from "next/server";
import { SignInAction } from "../../server/implementation.js";
import { getRequestCookies, getResponseCookies } from "./cookies.js";
import { isCorsRequest, jsonResponse, setAuthCookies } from "./utils.js";

export async function proxyAuthActionToConvex(
  request: NextRequest,
  options: { convexUrl?: string },
) {
  if (request.method !== "POST") {
    return new Response("Invalid method", { status: 405 });
  }
  if (isCorsRequest(request)) {
    return new Response("Invalid origin", { status: 403 });
  }
  const { action, args } = await request.json();
  if (action !== "auth:signIn" && action !== "auth:signOut") {
    return new Response("Invalid action", { status: 400 });
  }
  // The client has a dummy refreshToken, the real one is only
  // stored in cookies.
  if (action === "auth:signIn" && args.refreshToken !== undefined) {
    args.refreshToken = getRequestCookies().refreshToken;
  }
  const untypedResult = await fetchAction(action, args, {
    url: options?.convexUrl,
  });

  if (action === "auth:signIn") {
    const result = untypedResult as SignInAction["_returnType"];
    if (result.redirect !== undefined) {
      const { redirect } = result;
      const response = jsonResponse({ redirect });
      getResponseCookies(response).verifier = result.verifier;
      return response;
    } else if (result.tokens !== undefined) {
      const response = jsonResponse(result);
      setAuthCookies(response, result.tokens);
      return response;
    }
    return jsonResponse(result);
  } else {
    const response = jsonResponse(null);
    setAuthCookies(response, null);
    return response;
  }
}
