import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/loggedin")({
  component: About,
});

function About() {
  return <div className="p-2">Hello from About!</div>;
}
