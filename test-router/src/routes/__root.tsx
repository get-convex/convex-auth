import { Layout } from "@/Layout";
import { UserMenu } from "@/components/UserMenu";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import {
  Authenticated,
  Unauthenticated,
  useConvex,
  useQuery,
} from "convex/react";
import { api } from "../../convex/_generated/api";

export const Route = createRootRoute({
  component: () => <App />,
});

function App() {
  const convex = useConvex();
  return (
    <ConvexAuthProvider client={convex}>
      <Content />
    </ConvexAuthProvider>
  );
}

function Content() {
  const user = useQuery(api.users.viewer);
  return (
    <Layout
      menu={
        <>
          <Authenticated>
            <UserMenu>
              {user?.name ?? user?.email ?? user?.phone ?? "Anonymous"}
            </UserMenu>
          </Authenticated>
          <Unauthenticated>{null}</Unauthenticated>
        </>
      }
    >
      <Outlet />
      <TanStackRouterDevtools />
    </Layout>
  );
}
