import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProviderWithAuth } from "convex/react";
import { convex } from "./client";
import { useAuthFromSession } from "./auth";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProviderWithAuth client={convex} useAuth={useAuthFromSession}>
      <App />
    </ConvexProviderWithAuth>
  </StrictMode>,
);
