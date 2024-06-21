import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "./App";

test("starts as loading", () => {
  process.env.CONVEX_URL = "https://crazy-horse-123.convex.cloud";
  render(<App />);
  const status = screen.getByText("loading");
  expect(status).toBeInTheDocument();
});
