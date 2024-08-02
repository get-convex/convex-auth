"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { FormEvent, useState } from "react";
import { Message } from "./Message";
import { MessageList } from "./MessageList";

export function Chat({ viewer }: { viewer: Id<"users"> }) {
  const [newMessageText, setNewMessageText] = useState("");
  const messages = useQuery(api.messages.list);
  const sendMessage = useMutation(api.messages.send);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendMessage({ body: newMessageText })
      .then(() => {
        setNewMessageText("");
      })
      .catch((error) => {
        console.error("Failed to send message:", error);
      });
  };

  return (
    <>
      <MessageList messages={messages}>
        {messages?.map((message) => (
          <Message
            key={message._id}
            authorName={message.author}
            authorId={message.userId}
            viewerId={viewer}
          >
            {message.body}
          </Message>
        ))}
      </MessageList>
      <div className="border-t">
        <form onSubmit={handleSubmit} className="flex gap-2 p-4">
          <Input
            value={newMessageText}
            onChange={(event) => setNewMessageText(event.target.value)}
            placeholder="Write a message…"
          />
          <Button type="submit" disabled={newMessageText === ""}>
            Send
          </Button>
        </form>
      </div>
    </>
  );
}
