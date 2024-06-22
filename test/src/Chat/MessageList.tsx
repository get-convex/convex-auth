import { ReactNode, useEffect, useRef } from "react";

export function MessageList({ children }: { children: ReactNode }) {
  const messageListRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTo({
        top: messageListRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [children]);
  return (
    <ol
      ref={messageListRef}
      className="container flex grow flex-col gap-4 overflow-y-auto scroll-smooth px-8 py-4"
    >
      {children}
    </ol>
  );
}
