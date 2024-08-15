import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { routeTree } from "./routeTree.gen";

// Create a new router instance
const router = createRouter({ routeTree });

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const convex = new ConvexReactClient(
  import.meta.env.VITE_CONVEX_URL as string,
  { verbose: true },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class">
      <ConvexProvider client={convex}>
        <RouterProvider router={router} />
      </ConvexProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

// function Test() {
//   useEffect(() => {
//     const url = new URL(window.location.href);
//     if (url.searchParams.get("code") !== null) {
//       url.searchParams.delete("code");
//       window.history.replaceState({}, "", url.toString());
//       console.log("replaceing", url.toString());
//     }
//   });
//   return null;
// }
