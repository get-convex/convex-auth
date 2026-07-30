import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { convexAuthNextjsAccessToken } from "@/src/lib/convexAuth";
import { Dashboard } from "./Dashboard";

// Server Component: read the access token from the cookie and preload the
// authenticated query so the page renders signed-in on first paint (SSR).
export default async function Home() {
  const token = await convexAuthNextjsAccessToken();
  const preloaded = await preloadQuery(
    api.users.loggedInUser,
    {},
    { token: token ?? undefined },
  );
  return <Dashboard preloaded={preloaded} />;
}
