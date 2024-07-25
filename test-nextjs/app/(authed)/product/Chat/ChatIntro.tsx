export function ChatIntro() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className=" text-lg font-semibold md:text-2xl">Chat</h1>
      <p className="hidden sm:block text-sm text-muted-foreground">
        Open this app in multiple browser windows to see the real-time database
        in action
      </p>
    </div>
  );
}
