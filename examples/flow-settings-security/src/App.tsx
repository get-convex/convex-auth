import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
} from "@convex-dev/auth/react";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { LinkCallback } from "./routes/linkCallback";
import { Settings } from "./routes/settings";
import "./index.css";

export function App() {
  return (
    <main>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <Settings />
            </RequireAuth>
          }
        />
        {/* Return leg of the link-OAuth redirect; see linkCallback.tsx. */}
        <Route path="/callback" element={<LinkCallback />} />
      </Routes>
    </main>
  );
}

// This fixture assumes an existing session — any sign-in fixture (e.g.
// flow-password-email-verify) can front it — so there is no /login route
// here, just a notice.
function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <p>
          Not signed in. This fixture assumes an existing session — front it
          with any of the sign-in flow examples.
        </p>
      </Unauthenticated>
      <Authenticated>{children}</Authenticated>
    </>
  );
}
