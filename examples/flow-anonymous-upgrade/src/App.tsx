import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
} from "@convex-dev/auth/react";
import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Home } from "./routes/home";
import { Upgrade } from "./routes/upgrade";
import "./index.css";

export function App() {
  return (
    <main>
      <Routes>
        {/* "/" handles all three auth states itself: it signs visitors in
            anonymously instead of showing a login screen. */}
        <Route path="/" element={<Home />} />
        <Route
          path="/upgrade"
          element={
            <RequireAuth>
              <Upgrade />
            </RequireAuth>
          }
        />
      </Routes>
    </main>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        {/* "/" will establish a guest session first. */}
        <Navigate to="/" replace />
      </Unauthenticated>
      <Authenticated>{children}</Authenticated>
    </>
  );
}
