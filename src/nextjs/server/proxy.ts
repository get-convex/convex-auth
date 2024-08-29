import "server-only";

import { fetchAction } from "convex/nextjs";
import { NextRequest } from "next/server";
import { SignInAction } from "../../server/implementation/index.js";
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
  let token: string | undefined;
  if (action === "auth:signIn" && args.refreshToken !== undefined) {
    // The client has a dummy refreshToken, the real one is only
    // stored in cookies.
    const refreshToken = getRequestCookies().refreshToken;
    if (refreshToken === null) {
      console.error(
        "Convex Auth: Unexpected missing refreshToken cookie during client refresh",
      );
      return new Response(JSON.stringify({ tokens: null }));
    }
    args.refreshToken = refreshToken;
  } else {
    // Make sure the proxy is authenticated if the client is,
    // important for signOut and any other logic working
    // with existing sessions.
    token = getRequestCookies().token ?? undefined;
  }
  const untypedResult = await fetchAction(action, args, {
    url: options?.convexUrl,
    token,
  });

  if (action === "auth:signIn") {
    const result = untypedResult as SignInAction["_returnType"];
    if (result.redirect !== undefined) {
      const { redirect } = result;
      const response = jsonResponse({ redirect });
      getResponseCookies(response).verifier = result.verifier;
      return response;
    } else if (result.tokens !== undefined) {
      // The server doesn't share the refresh token with the client
      // for added security - the client has to use the server
      // to refresh the access token via cookies.
      const response = jsonResponse({
        tokens:
          result.tokens !== null
            ? { token: result.tokens.token, refreshToken: "dummy" }
            : null,
      });
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
