import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import { Chat } from "@/Chat/Chat";
import { ChatHeader } from "@/Chat/ChatIntro";
import { Layout } from "@/Layout";
import { SignInFormsShowcase } from "@/auth/SignInFormsShowcase";
import { UserMenu } from "@/components/UserMenu";
import { api } from "../../convex/_generated/api";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";

export const Route = createRootRoute({
  component: () => <App />,
});

function App() {
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
