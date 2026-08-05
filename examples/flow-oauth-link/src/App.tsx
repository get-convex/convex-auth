import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
} from "@convex-dev/auth/react";
import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Callback } from "./routes/callback";
import { Dashboard } from "./routes/dashboard";
import { LogIn } from "./routes/logIn";
import "./index.css";

export function App() {
  return (
    <main>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <Dashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/login"
          element={
            <RequireNoAuth>
              <LogIn />
            </RequireNoAuth>
          }
        />
        {/* Deliberately not auth-gated: the user transitions from
            unauthenticated to authenticated while this route runs. */}
        <Route path="/callback" element={<Callback />} />
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
        <Navigate to="/login" replace />
      </Unauthenticated>
      <Authenticated>{children}</Authenticated>
    </>
  );
}

function RequireNoAuth({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Authenticated>
        <Navigate to="/" replace />
      </Authenticated>
      <Unauthenticated>{children}</Unauthenticated>
    </>
  );
}
