import { ConvexLogo } from "@/GetStarted/ConvexLogo";
import { Code } from "@/components/Code";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  CodeIcon,
  ExternalLinkIcon,
  MagicWandIcon,
  PlayIcon,
  StackIcon,
} from "@radix-ui/react-icons";
import { ReactNode } from "react";

export function GetStartedDialog({ children }: { children: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[calc(100vh-8rem)] grid-rows-[1fr_auto]">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            Your app powered by <ConvexLogo width={69} height={11} />
          </DialogTitle>
        </DialogHeader>
        <GetStartedContent />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Got it</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GetStartedContent() {
  return (
    <div className="overflow-y-auto">
      <p className="text-muted-foreground mb-2">
        This template is a starting point for building your fullstack web
        application.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex gap-2">
              <PlayIcon /> Play with the app
            </CardTitle>
          </CardHeader>
          <CardContent>Close this dialog to see the app in action.</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex gap-2">
              <StackIcon /> Inspect your database
            </CardTitle>
          </CardHeader>
          <CardContent>
            The{" "}
            <a
              href="https://dashboard.convex.dev/"
              className="underline underline-offset-4 hover:no-underline"
              target="_blank"
            >
              Convex dashboard
            </a>{" "}
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
            Edit <Code>src/App.tsx</Code> to change your frontend.
          </CardContent>
        </Card>
      </div>
      <div>
        <h2 className="mt-6 mb-3 font-semibold">Helpful resources</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <Resource title="Convex Docs" href="https://docs.convex.dev/home">
            Read comprehensive documentation for all Convex features.
          </Resource>
          <Resource title="Stack articles" href="https://stack.convex.dev/">
            Learn about best practices, use cases, and more from a growing
            collection of articles, videos, and walkthroughs.
          </Resource>
          <Resource title="Discord" href="https://www.convex.dev/community">
            Join our developer community to ask questions, trade tips & tricks,
            and show off your projects.
          </Resource>
          <Resource title="Search them all" href="https://search.convex.dev/">
            Get unblocked quickly by searching across the docs, Stack, and
            Discord chats.
          </Resource>
        </div>
      </div>
    </div>
  );
}

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
      className="flex h-auto flex-col items-start justify-start gap-2 whitespace-normal p-4 font-normal"
    >
      <a href={href} target="_blank">
        <div className="text-sm font-bold flex items-center gap-1">
          {title}
          <ExternalLinkIcon />
        </div>
        <div className="text-muted-foreground">{children}</div>
      </a>
    </Button>
  );
}
