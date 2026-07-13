import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { convexAuthNextjsToken } from "@/convexAuth";
import { Dashboard } from "./Dashboard";

/**
 * A protected, server-rendered page. Middleware guarantees a signed-in user and
 * a fresh access token in cookies; we read that token and preload an
 * authenticated query on the server, so the first paint already shows the
 * user's data (no client round-trip).
 */
export default async function Home() {
  const token = await convexAuthNextjsToken();
  const preloaded = await preloadQuery(
    api.users.loggedInUser,
    {},
    { token: token ?? undefined },
  );
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Convex Auth — Next.js SSR</h1>
      <Dashboard preloaded={preloaded} />
    </main>
  );
}
