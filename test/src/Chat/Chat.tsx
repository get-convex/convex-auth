import { Message } from "@/Chat/Message";
import { MessageList } from "@/Chat/MessageList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery } from "convex/react";
import { FormEvent, useState } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

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
      <MessageList>
        {messages?.map((message) => (
          <Message
            key={message._id}
            author={message.userId}
            authorName={message.author}
            viewer={viewer}
          >
            {message.body}
          </Message>
        ))}
      </MessageList>
      <div className="border-t">
        <form onSubmit={handleSubmit} className="container flex gap-2 py-4">
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
