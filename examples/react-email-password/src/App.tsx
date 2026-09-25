import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
} from "@convex-dev/auth/react";
import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Dashboard } from "./routes/dashboard";
import { LogIn } from "./routes/logIn";
import { SignUp } from "./routes/signUp";
import { ValidateEmail } from "./routes/validateEmail";
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
        <Route
          path="/signup"
          element={
            <RequireNoAuth>
              <SignUp />
            </RequireNoAuth>
          }
        />
        {/* The landing pages for emailed links have no auth guard: the
            user's auth state when they open a link is unpredictable. */}
        <Route path="/validate-email" element={<ValidateEmail />} />
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
