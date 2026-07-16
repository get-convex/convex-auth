import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import App from "./App";
import { AuthProvider } from "./auth";
import "./index.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

/**
 * Locates the mount node and renders the app into it.
 */
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthProvider client={convex}>
      <App />
    </AuthProvider>
  </StrictMode>,
);
