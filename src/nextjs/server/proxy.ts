import "server-only";

import { fetchAction } from "convex/nextjs";
import { NextRequest } from "next/server";
import { SignInAction } from "../../server/implementation";
import { getResponseCookies } from "./cookies";
import { jsonResponse, setAuthCookies } from "./utils";

export async function proxyAuthActionToConvex(
  request: NextRequest,
  options: { convexUrl?: string },
) {
  const origin = request.headers.get("Origin");
  const originHost = origin ? new URL(origin).host : null;
  if (originHost !== request.headers.get("Host")) {
    return new Response("Invalid origin", { status: 403 });
  }
  if (request.method !== "POST") {
    return new Response("Invalid method", { status: 405 });
  }
  const { action, args } = await request.json();
  if (action !== "auth:signIn" && action !== "auth:signOut") {
    return new Response("Invalid action", { status: 400 });
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
  } else {
    const response = jsonResponse(null);
    setAuthCookies(response, null);
    return response;
  }
}
