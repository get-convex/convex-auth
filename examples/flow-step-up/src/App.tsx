import { Route, Routes } from "react-router-dom";
import { Dashboard } from "./routes/dashboard";
import "./index.css";

// Fixture note: sign-in itself is out of scope for this example (see the
// other flow-* fixtures), so there is no auth gate here — the page renders
// as if authenticated, and every call throws its TODO until the stubs are
// implemented. What this fixture captures is the STRUCTURE: sensitive
// operations guarded server-side by RECENT re-auth, a shared useStepUp
// helper that catches REAUTH_REQUIRED, re-auths, and retries.
export function App() {
  return (
    <main>
      <Routes>
        <Route path="/" element={<Dashboard />} />
      </Routes>
    </main>
  );
}
