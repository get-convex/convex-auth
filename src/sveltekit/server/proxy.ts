import { RequestEvent } from "@sveltejs/kit";

export function shouldProxyAuthAction(event: RequestEvent, apiRoute: string) {
  // Handle both with and without trailing slash since this could be configured either way.
  // https://nextjs.org/docs/app/api-reference/next-config-js/trailingSlash
  const requestUrl = event.url;
  if (apiRoute.endsWith("/")) {
    return (
      requestUrl.pathname === apiRoute ||
      requestUrl.pathname === apiRoute.slice(0, -1)
    );
  } else {
    return (
      requestUrl.pathname === apiRoute || requestUrl.pathname === apiRoute + "/"
    );
  }
}
