import { Chat } from "@/Chat/Chat";
import { ChatHeader } from "@/Chat/ChatIntro";
import { Layout } from "@/Layout";
import { SignInFormsShowcase } from "@/auth/SignInFormsShowcase";
import { UserMenu } from "@/components/UserMenu";
import { api } from "../convex/_generated/api";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";

export default function App() {
  const user = useQuery(api.users.viewer);
  return (
    <Layout
      menu={
        <>
          <Authenticated>
            <UserMenu favoriteColor={user?.favoriteColor}>
              {user?.name ?? user?.email ?? user?.phone ?? "Anonymous"}
            </UserMenu>
          </Authenticated>
          <Unauthenticated>{null}</Unauthenticated>
        </>
      }
    >
      <>
        <Authenticated>
          <ChatHeader />
          {/* eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain */}
          <Chat viewer={user?._id!} />
        </Authenticated>
        <Unauthenticated>
          <SignInFormsShowcase />
        </Unauthenticated>
      </>
    </Layout>
  );
}
