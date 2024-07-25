import { ConvexLogo } from "@/app/(splash)/GetStarted/ConvexLogo";
import { Code } from "@/components/Code";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CodeIcon,
  MagicWandIcon,
  PlayIcon,
  StackIcon,
} from "@radix-ui/react-icons";
import Link from "next/link";
import { ReactNode } from "react";

export const GetStarted = () => {
  return (
    <div className="flex grow flex-col">
      <div className="container mb-20 flex grow flex-col justify-center">
        <h1 className="mb-8 mt-16 flex flex-col items-center gap-8 text-center text-6xl font-extrabold leading-none tracking-tight">
          Your app powered by
          <ConvexLogo width={377} height={44} />
        </h1>
        <div className="mb-8 text-center text-lg text-muted-foreground">
          Build a realtime full-stack app in no time.
        </div>
        <div className="mb-16 flex justify-center gap-4">
          <Button asChild size="lg">
            <Link href="/product">Get Started</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="https://docs.convex.dev/home">Convex docs</Link>
          </Button>
        </div>
        <div className="flex flex-col gap-4 bg-muted/50 p-12 dark:bg-transparent">
          <h2 className="mb-1 text-center text-3xl font-bold md:text-4xl ">
            Next steps
          </h2>
          <div className="mb-1 text-center text-muted-foreground">
            This template is a starting point for building your web application.
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex gap-2">
                  <PlayIcon /> Play with the app
                </CardTitle>
              </CardHeader>
              <CardContent>
                Click on{" "}
                <Link
                  href="/product"
                  className="font-medium underline underline-offset-4 hover:no-underline"
                >
                  Get Started
                </Link>{" "}
                to see the app in action.
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex gap-2">
                  <StackIcon /> Inspect your database
                </CardTitle>
              </CardHeader>
              <CardContent>
                The{" "}
                <Link
                  href="https://dashboard.convex.dev/"
                  className="underline underline-offset-4 hover:no-underline"
                  target="_blank"
                >
                  Convex dashboard
                </Link>{" "}
                is already open in another window.
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex gap-2">
                  <CodeIcon />
                  Change the backend
                </CardTitle>
              </CardHeader>
              <CardContent>
                Edit <Code>convex/messages.ts</Code> to change the backend
                functionality.
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex gap-2">
                  <MagicWandIcon />
                  Change the frontend
                </CardTitle>
              </CardHeader>
              <CardContent>
                Edit <Code>app/page.tsx</Code> to change your frontend.
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <div className="px-20 pb-20">
        <div className="container">
          <h2 className="mb-6 text-center text-2xl font-bold">
            Helpful resources
          </h2>
          <div className="grid gap-6 md:grid-cols-4">
            <Resource title="Convex Docs" href="https://docs.convex.dev/home">
              Read comprehensive documentation for all Convex features.
            </Resource>
            <Resource title="Stack articles" href="https://stack.convex.dev/">
              Learn about best practices, use cases, and more from a growing
              collection of articles, videos, and walkthroughs.
            </Resource>
            <Resource title="Discord" href="https://www.convex.dev/community">
              Join our developer community to ask questions, trade tips &
              tricks, and show off your projects.
            </Resource>
            <Resource title="Search them all" href="https://search.convex.dev/">
              Get unblocked quickly by searching across the docs, Stack, and
              Discord chats.
            </Resource>
          </div>
        </div>
      </div>
    </div>
  );
};

function Resource({
  title,
  children,
  href,
}: {
  title: string;
  children: ReactNode;
  href: string;
}) {
  return (
    <Button
      asChild
      variant="secondary"
      className="flex h-auto flex-col items-start justify-start gap-4 whitespace-normal p-4 font-normal"
    >
      <Link href={href}>
        <div className="text-sm font-bold">{title}</div>
        <div className="text-muted-foreground">{children}</div>
      </Link>
    </Button>
  );
}
